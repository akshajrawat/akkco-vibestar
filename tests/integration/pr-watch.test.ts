import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Rpc } from "../../backend/rpc";
import { PRWatch } from "../../backend/review/pr/watch";
import type { PRWatchContext } from "../../backend/review/pr/watch-github";
import { createFixtureEngine } from "../helpers/fixtures";

let dir: string;
let engine: Awaited<ReturnType<typeof createFixtureEngine>>;
let rpc: Rpc;

const context = (number: number): PRWatchContext => ({
  url: `https://github.com/upstream/project/pull/${number}`,
  title: `Contribution ${number}`,
  body: "Fixes #10. Implement the issue.",
  lifecycle: "OPEN",
  updated_at: "2026-10-28T00:00:00Z",
  head: "a".repeat(40),
  viewer: "akshajrawat",
  review_decision: null,
  requested_reviewers: 0,
  issues: [
    {
      url: "https://github.com/upstream/project/issues/10",
      title: "Original issue",
      body: "Original acceptance criteria",
      state: "OPEN",
    },
  ],
  sources: [
    {
      id: `comment-${number}`,
      body: "Please update this test.",
      url: `https://github.com/upstream/project/pull/${number}#issuecomment-${number}`,
      author: "reviewer",
      kind: "comment",
    },
  ],
  complete: true,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vibestar-pr-watch-"));
  engine = await createFixtureEngine(join(dir, "data"));
  rpc = new Rpc(engine);

  vi.spyOn(rpc.github, "refreshPullRequests").mockImplementation(async () => ({
    ...rpc.github.snapshot(),
    error: null,
    pull_requests: [1, 2, 3, 4, 5].map((number) => ({
      url: context(number).url,
      title: context(number).title,
      repository: "upstream/project",
      number,
      state: "OPEN",
      head_branch: "feature",
      head_repository: "akshajrawat/project",
      updated_at: "2026-10-28T00:00:00Z",
      task_id: null,
    })),
  }));
});

afterEach(async () => {
  await rpc.close();
  await engine.close();
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const finish = async () => {
  await vi.waitFor(() => expect(rpc.prWatch.snapshot()?.status).not.toBe("running"));
  return rpc.prWatch.snapshot()!;
};

const classifier = () =>
  vi.spyOn(engine.utility, "run").mockImplementation(async (request) => {
    const data = JSON.parse(
      request.prompt.split("\nPR_WATCH_CONTEXT_JSON\n")[1],
    ) as (PRWatchContext & { key: string })[];

    expect(request.prompt).toContain("do not use tools");
    expect(data.every((pr) => pr.issues[0].body === "Original acceptance criteria")).toBe(true);
    expect(data.some((pr) => "files" in pr || "commits" in pr)).toBe(false);
    return {
      results: data.map((pr) => ({
        key: pr.key,
        needs_review: true,
        reason: "Reviewer asked for a test change.",
        source_ids: [pr.sources[0].id],
      })),
    };
  });

it.each([false, true])(
  "reads only PR conversation and linked issue bodies, reporting pagination=%s",
  async (hasNextPage) => {
    const source = {
      id: "comment-1",
      body: "Please update this test",
      url: context(1).url,
      author: { login: "reviewer" },
    };

    const connection = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false } });

    const graphql = vi.spyOn(rpc.github.client, "graphql").mockResolvedValue({
      data: {
        viewer: { login: "akshajrawat" },
        repository: {
          pullRequest: {
            url: context(1).url,
            title: "Contribution",
            body: "Closes #10",
            state: "OPEN",
            updatedAt: "now",
            headRefOid: "a".repeat(40),
            reviewDecision: null,
            reviewRequests: { totalCount: 0 },
            comments: { ...connection([source]), pageInfo: { hasNextPage } },
            reviews: connection([]),
            reviewThreads: connection([
              {
                id: "thread",
                isResolved: false,
                isOutdated: false,
                comments: connection([{ ...source, id: "inline-1" }]),
              },
            ]),
            closingIssuesReferences: connection(context(1).issues),
          },
        },
      },
    });

    const result = await rpc.prWatch.reader.read(context(1).url, new AbortController().signal);
    expect(result.complete).toBe(!hasNextPage);
    expect(result.sources).toHaveLength(2);
    expect(result.issues[0].body).toBe("Original acceptance criteria");
    expect(graphql).toHaveBeenCalledOnce();
    expect(graphql.mock.calls[0][0]).not.toMatch(/files\(|commits\(|checkRuns/);
  },
);

it("retrieves conversations concurrently and triages five PRs with a single compact model call", async () => {
  let inFlight = 0;
  let maximum = 0;

  vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) => {
    maximum = Math.max(maximum, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    return context(Number(url.split("/").at(-1)));
  });

  const infer = classifier();

  const config = {
    ...engine.db.settings().utility_ai,
    provider: "codex" as const,
    model: "review-model",
    effort: "low",
  };

  engine.db.saveSettings({ ...engine.db.settings(), review_ai: config });
  await rpc.call("pr.watch.start", { request_id: randomUUID(), trigger: "open" });
  const result = await finish();
  expect(maximum).toBe(4);
  expect(infer).toHaveBeenCalledOnce();
  expect(infer.mock.calls[0][0].configuration).toEqual(config);
  expect(result.items.every((item) => item.status === "review")).toBe(true);
  expect(engine.db.all("SELECT id FROM pr_analyses")).toEqual([]);
  await rpc.call("pr.watch.start", { request_id: randomUUID(), trigger: "open" });
  expect(rpc.github.refreshPullRequests).toHaveBeenCalledOnce();

  await rpc.call("pr.watch.start", {
    request_id: randomUUID(),
    trigger: "recheck",
    configuration: {
      provider: config.provider,
      config: { model: config.model, effort: config.effort, timeout_secs: config.timeout_secs },
    },
  });

  await finish();
  expect(rpc.github.refreshPullRequests).toHaveBeenCalledTimes(2);
  expect(infer).toHaveBeenCalledOnce();
});

it("assesses review requests with the conversation, ignores own comments and retains incomplete retrieval", async () => {
  let release!: () => void;

  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) => {
    const number = Number(url.split("/").at(-1));
    const data = context(number);
    if (number === 1) data.review_decision = "CHANGES_REQUESTED";
    if (number === 2) data.requested_reviewers = 1;
    if (number === 3) data.sources[0].author = "AkshaJRawat";
    if (number === 4) data.complete = false;
    if (number === 5) await blocked;
    return data;
  });

  const infer = classifier();
  rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
  await vi.waitFor(() => expect(rpc.prWatch.snapshot()?.items[2].status).toBe("clear"));
  expect(rpc.prWatch.snapshot()?.items[0].status).toBe("checking");
  expect(rpc.prWatch.snapshot()?.items[1].status).toBe("checking");
  expect(rpc.prWatch.snapshot()?.items[2].status).toBe("clear");
  expect(rpc.prWatch.snapshot()?.items[3].status).toBe("unknown");
  expect(infer).not.toHaveBeenCalled();
  release();
  await finish();
  expect(infer).toHaveBeenCalledOnce();
});

it.each(["fabricated evidence", "missing PR", "timeout"])(
  "keeps %s uncertain and does not automatically retry",
  async (failure) => {
    vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) =>
      context(Number(url.split("/").at(-1))),
    );

    const infer = classifier();
    if (failure === "timeout") infer.mockRejectedValue(new Error("Run exceeded 120s timeout"));
    else if (failure === "missing PR") infer.mockResolvedValue({ results: [] });
    else
      infer.mockImplementation(async (request) => {
        const data = JSON.parse(request.prompt.split("\nPR_WATCH_CONTEXT_JSON\n")[1]) as {
          key: string;
        }[];

        return {
          results: data.map((pr) => ({
            key: pr.key,
            needs_review: true,
            reason: "Unverified",
            source_ids: ["invented"],
          })),
        };
      });
    rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
    const result = await finish();
    expect(result.items.every((item) => item.status === "unknown")).toBe(true);
    expect(infer).toHaveBeenCalledOnce();
    await rpc.prWatch.close();
    const restarted = new PRWatch(engine, rpc.github);
    expect(restarted.snapshot()?.items.every((item) => item.status === "unknown")).toBe(true);
    restarted.start({ request_id: randomUUID(), trigger: "open" });
    expect(rpc.github.refreshPullRequests).toHaveBeenCalledOnce();
    expect(infer).toHaveBeenCalledOnce();
    await restarted.close();
  },
);

it("cancels all concurrent reads, retains finished decisions and does not replay on reopen", async () => {
  vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url, signal) => {
    if (url.endsWith("/1")) return { ...context(1), requested_reviewers: 1, sources: [] };
    return new Promise<never>((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
    );
  });

  const infer = classifier();
  rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
  await vi.waitFor(() => expect(rpc.prWatch.snapshot()?.items[0].status).toBe("waiting"));
  await rpc.prWatch.cancel();
  expect(rpc.prWatch.snapshot()?.status).toBe("cancelled");
  expect(rpc.prWatch.snapshot()?.items[0].status).toBe("waiting");

  expect(
    rpc.prWatch
      .snapshot()
      ?.items.slice(1)
      .every((item) => item.status === "unknown"),
  ).toBe(true);

  rpc.prWatch.start({ request_id: randomUUID(), trigger: "open" });
  expect(rpc.github.refreshPullRequests).toHaveBeenCalledOnce();
  expect(infer).not.toHaveBeenCalled();
});

it("stops before metadata retrieval when cancelled immediately", async () => {
  rpc.prWatch.start({ request_id: randomUUID(), trigger: "open" });
  await rpc.prWatch.cancel();
  expect(rpc.github.refreshPullRequests).not.toHaveBeenCalled();
  expect(rpc.prWatch.snapshot()?.status).toBe("cancelled");
});

it("keeps successful negative classifications clear and reclassifies edited conversations", async () => {
  const reader = vi
    .spyOn(rpc.prWatch.reader, "read")
    .mockImplementation(async (url) => context(Number(url.split("/").at(-1))));

  const infer = vi.spyOn(engine.utility, "run").mockResolvedValue({
    results: [0, 1, 2, 3, 4].map((key) => ({
      key: String(key),
      needs_review: false,
      reason: "The conversation is resolved.",
      source_ids: [],
    })),
  });

  rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
  expect((await finish()).items.every((item) => item.status === "clear")).toBe(true);
  const configuration = engine.db.settings().utility_ai;

  rpc.prWatch.start({
    request_id: randomUUID(),
    trigger: "recheck",
    configuration: {
      provider: configuration.provider,
      config: {
        model: configuration.model,
        effort: configuration.effort,
        timeout_secs: configuration.timeout_secs,
      },
    },
  });

  await finish();
  expect(infer).toHaveBeenCalledOnce();

  reader.mockImplementation(async (url) => ({
    ...context(Number(url.split("/").at(-1))),
    body: "Updated issue context",
  }));

  rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
  await finish();
  expect(infer).toHaveBeenCalledTimes(2);
});

it("shows a pending reviewer assignment as waiting, without an AI call or work flag", async () => {
  vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) => ({
    ...context(Number(url.split("/").at(-1))),
    requested_reviewers: 1,
    sources: [],
  }));

  const infer = classifier();
  rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
  const result = await finish();
  expect(result.items.every((item) => item.status === "waiting")).toBe(true);
  expect(infer).not.toHaveBeenCalled();
});

it.each(["REVIEW_REQUIRED", "CHANGES_REQUESTED"])(
  "considers answered comments despite the lingering %s decision",
  async (decision) => {
    vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) => {
      const number = Number(url.split("/").at(-1));
      return {
        ...context(number),
        requested_reviewers: 1,
        review_decision: decision,
        sources: [
          {
            ...context(number).sources[0],
            kind: "inline",
            thread_id: "thread-1",
            resolved: false,
            outdated: false,
            createdAt: "2026-10-01T10:00:00Z",
          },
          {
            id: `reply-${number}`,
            author: "AkshaJRawat",
            body: "Updated the tests and supplied both stress test links. This addresses the review.",
            url: `${url}#issuecomment-reply`,
            kind: "comment",
            createdAt: "2026-10-02T10:00:00Z",
          },
        ],
      };
    });

    const infer = vi.spyOn(engine.utility, "run").mockImplementation(async (request) => {
      expect(request.prompt).toContain(
        "Do not require reviewer acknowledgment or code verification",
      );

      expect(request.prompt).toContain("ALONE never mean the viewer owes action");

      const payload = JSON.parse(
        request.prompt.split("\nPR_WATCH_CONTEXT_JSON\n")[1],
      ) as (PRWatchContext & { key: string })[];

      expect(
        payload.every((pr) =>
          pr.sources.some(
            (source) =>
              source.author === "AkshaJRawat" && source.body.includes("both stress test links"),
          ),
        ),
      ).toBe(true);

      return {
        results: payload.map((pr) => ({
          key: pr.key,
          needs_review: false,
          reason:
            "The author addressed the request and supplied test links; waiting for the reviewer.",
          source_ids: pr.sources.map((source) => source.id),
        })),
      };
    });

    rpc.prWatch.start({ request_id: randomUUID(), trigger: "open" });
    const result = await finish();
    expect(result.items.every((item) => item.status === "waiting")).toBe(true);
    expect(infer).toHaveBeenCalledOnce();
    rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
    await finish();
    expect(infer).toHaveBeenCalledOnce();
  },
);

it("still flags a new unanswered reviewer follow-up after an author reply", async () => {
  vi.spyOn(rpc.prWatch.reader, "read").mockImplementation(async (url) => ({
    ...context(Number(url.split("/").at(-1))),
    requested_reviewers: 1,
    sources: [
      {
        id: "old",
        author: "reviewer",
        body: "Please update the test.",
        url,
        kind: "comment",
        createdAt: "2026-10-01T10:00:00Z",
      },
      {
        id: "reply",
        author: "akshajrawat",
        body: "Updated the test.",
        url,
        kind: "comment",
        createdAt: "2026-10-02T10:00:00Z",
      },
      {
        id: "followup",
        author: "reviewer",
        body: "Thanks. Can you add the missing edge case too?",
        url,
        kind: "comment",
        createdAt: "2026-10-03T10:00:00Z",
      },
    ],
  }));

  const infer = vi.spyOn(engine.utility, "run").mockImplementation(async (request) => {
    const data = JSON.parse(request.prompt.split("\nPR_WATCH_CONTEXT_JSON\n")[1]) as {
      key: string;
    }[];

    return {
      results: data.map((pr) => ({
        key: pr.key,
        needs_review: true,
        reason: "A later request for an edge-case test is unanswered.",
        source_ids: ["followup"],
      })),
    };
  });

  rpc.prWatch.start({ request_id: randomUUID(), trigger: "recheck" });
  expect((await finish()).items.every((item) => item.status === "review")).toBe(true);
  expect(infer).toHaveBeenCalledOnce();
});
