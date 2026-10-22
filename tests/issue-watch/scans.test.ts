import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { migrateDataRoot } from "../../backend/storage/migrate-root";
import { createFixtureEngine } from "../fixtures";
import { IssueWatchStore } from "../../backend/issue-watch/store";
import { watchConfiguration, watchFixture, githubIssue } from "./fixtures";

const resources: Awaited<ReturnType<typeof watchFixture>>[] = [];
const setup = async () => {
  const fixture = await watchFixture();
  resources.push(fixture);
  return fixture;
};
afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.close();
  vi.restoreAllMocks();
});

it("creates immutable idempotent watches, reads history across restart, and never scans on save/open/startup", async () => {
  const f = await setup();
  const infer = vi.spyOn(f.engine.utility, "run");
  const input = {
    request_id: randomUUID(),
    name: "Saved watch",
    repository: "oppia/oppia",
    configuration: watchConfiguration(),
  };
  const [first, same] = (await Promise.all([
    f.service.save(input),
    f.service.save(input),
  ])) as Awaited<ReturnType<typeof f.service.store.saveRevision>>[];
  expect(first.watch.id).toBe(same.watch.id);
  expect(f.api).toHaveBeenCalledTimes(1);
  expect(f.service.store.history(first.watch.id)).toEqual([]);
  await f.service.call("list", {});
  await f.service.call("detail", { watch_id: first.watch.id });
  expect(f.api).toHaveBeenCalledTimes(1);
  expect(infer).not.toHaveBeenCalled();
  expect(() => f.service.save({ ...input, name: "Different" })).toThrow(
    "different operation or payload",
  );
  const update = (await f.service.save(
    {
      ...input,
      request_id: randomUUID(),
      watch_id: first.watch.id,
      expected_revision: 1,
      name: "Revision two",
    },
    true,
  )) as typeof first;
  expect(update.revision.revision).toBe(2);
  expect(f.service.store.revision(first.watch.id, 1).configuration).toEqual(
    input.configuration,
  );
  await expect(
    f.service.save(
      {
        ...input,
        request_id: randomUUID(),
        watch_id: first.watch.id,
        expected_revision: 1,
      },
      true,
    ),
  ).rejects.toThrow("Watch changed");
  const reads = f.api.mock.calls.length;
  await f.restart();
  expect(f.api).toHaveBeenCalledTimes(reads);
  expect(f.service.store.get(first.watch.id).name).toBe("Revision two");
  expect(f.engine.db.repositories()).toEqual([]);
});

it("dynamically excludes tracker members, enforces current metadata and blocks incomplete trackers without replacing baseline", async () => {
  const f = await setup();
  const configuration = watchConfiguration("Open issues", {
    excluded_labels: ["triage needed"],
    unassigned_only: true,
    trackers: [
      { url: "https://github.com/oppia/oppia/issues/27409", comments: "none" },
    ],
  });
  const { watch } = await f.create(configuration);
  f.issues.set(3, { ...githubIssue(3), labels: [{ name: "TRIAGE NEEDED" }] });
  f.issues.set(4, {
    ...githubIssue(4),
    assignees: [{ login: "already-assigned" }],
  });
  f.issues.set(5, { ...githubIssue(5), state: "closed" });
  const first = await f.scan(watch.id);
  expect(first).toMatchObject({
    status: "completed",
    semantic_attempts: 0,
    coverage: { exclusions_complete: true, checked: 6, excluded: 5 },
  });
  expect(
    f.service.store.results(watch.id).find((row) => row.issue.number === 1),
  ).toMatchObject({
    classification: "initial_discovery",
    claim_state: "candidate_for_claim_request",
  });
  expect(
    f.service.store.results(watch.id).filter((row) => row.eligible),
  ).toHaveLength(1);
  f.issues.get(27409)!.body = "#1 and https://github.com/other/repo/issues/2";
  f.issues.get(27409)!.updated_at = "2026-10-02T00:00:00Z";
  const second = await f.scan(watch.id);
  expect(second.status).toBe("completed");
  const results = f.service.store.results(watch.id);
  expect(results.find((row) => row.issue.number === 1)?.classification).toBe(
    "no_longer_eligible",
  );
  expect(results.find((row) => row.issue.number === 2)?.classification).toBe(
    "newly_matching",
  );
  expect(
    f.service.store
      .sources(watch.id, second.id)
      .find((source) => source.kind === "tracker")?.text,
  ).toContain("#1");
  f.overrides.set("repos/oppia/oppia/issues/27409", () => {
    throw new Error("Rate limited required tracker");
  });
  const blocked = await f.scan(watch.id);
  expect(blocked).toMatchObject({
    status: "blocked",
    semantic_attempts: 0,
    coverage: { exclusions_complete: false },
  });
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(second.id);
  expect(f.service.store.results(watch.id)).toEqual(results);
  await f.restart();
  expect(f.service.store.history(watch.id)).toHaveLength(3);
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(second.id);
});

it("fails closed on all-comment tracker coverage and keeps body-only scans bounded", async () => {
  const f = await setup();
  const tracker = f.issues.get(27409)!;
  tracker.comments = 1;
  f.comments.set(27409, [
    {
      node_id: "TC_1",
      body: "#1",
      html_url: tracker.html_url + "#issuecomment-1",
      user: { login: "maintainer" },
      author_association: "MEMBER",
      created_at: tracker.created_at,
      updated_at: tracker.updated_at,
    },
  ]);
  const { watch } = await f.create(
    watchConfiguration("Open issues", {
      trackers: [{ url: tracker.html_url, comments: "all" }],
    }),
  );
  const complete = await f.scan(watch.id);
  expect(complete.status).toBe("completed");
  expect(f.service.store.results(watch.id).every((row) => !row.eligible)).toBe(
    true,
  );
  f.comments.set(27409, []);
  const blocked = await f.scan(watch.id);
  expect(blocked.status).toBe("blocked");
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(complete.id);
});

it("reserves one durable manual scan, rejects payload/cross-watch reuse and cancels before inference", async () => {
  const f = await setup();
  const { watch } = await f.create();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.overrides.set("repos/oppia/oppia", async () => {
    await gate;
    return {
      node_id: "R_oppia",
      full_name: "oppia/oppia",
      html_url: "https://github.com/oppia/oppia",
    };
  });
  const request = {
    watch_id: watch.id,
    expected_revision: 1,
    request_id: randomUUID(),
  };
  const first = f.service.launch(request);
  expect(f.service.launch(request)).toEqual(first);
  expect(() =>
    f.service.launch({ ...request, instruction_override: "Prefer Python" }),
  ).toThrow("different operation or payload");
  expect(() =>
    f.service.launch({ ...request, request_id: randomUUID() }),
  ).toThrow("active scan");
  expect(
    f.engine
      .cleanupBlockers()
      .some((blocker) => blocker.kind === "issue_watch"),
  ).toBe(true);
  const cancelled = f.service.cancel(watch.id, first.scan_id);
  release();
  expect((await cancelled).status).toBe("cancelled");
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBeNull();
  expect(f.service.store.scan(watch.id, first.scan_id).semantic_attempts).toBe(
    0,
  );
  expect(f.engine.cleanupBlockers()).toEqual([]);
  expect(() => f.service.store.scan(randomUUID(), first.scan_id)).toThrow(
    "does not belong",
  );
  await f.restart();
  expect(f.service.launch(request)).toEqual(first);
  expect(f.service.store.history(watch.id)).toHaveLength(1);
});

it("preserves partial discoveries and the old baseline when search/context budgets or identities are incomplete", async () => {
  const f = await setup();
  const { watch } = await f.create();
  const baseline = await f.scan(watch.id);
  expect(baseline.status).toBe("completed");
  f.overrides.set(
    "search/issues?q=repo%3Aoppia%2Foppia%20is%3Aissue%20is%3Aopen&sort=updated&order=desc&per_page=100&page=1",
    {
      total_count: 9999,
      incomplete_results: true,
      items: [
        {
          node_id: "I_1",
          number: 1,
          html_url: "https://github.com/oppia/oppia/issues/1",
        },
      ],
    },
  );
  const partial = await f.scan(watch.id);
  expect(partial.status).toBe("partial");
  expect(partial.coverage.search_complete).toBe(false);
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(baseline.id);
  expect(f.service.store.candidates(watch.id, partial.id)).toHaveLength(3);
  f.overrides.set("repos/oppia/oppia", {
    node_id: "R_impostor",
    full_name: "oppia/oppia",
    html_url: "https://github.com/oppia/oppia",
  });
  const failed = await f.scan(watch.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("Repository identity changed");
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(baseline.id);
});

it("marks interrupted attempts locally at startup and never replays their unused semantic slot", async () => {
  const f = await setup();
  const { watch } = await f.create();
  const finished = await f.scan(watch.id);
  const row = f.service.store.scan(watch.id, finished.id);
  f.service.store.saveScan({
    ...row,
    status: "running",
    phase: "Screening",
    ended_at: null,
    semantic_attempts: 1,
  });
  const reads = f.api.mock.calls.length;
  await f.restart();
  expect(f.service.store.scan(watch.id, row.id)).toMatchObject({
    status: "interrupted",
    semantic_attempts: 1,
  });
  expect(f.api).toHaveBeenCalledTimes(reads);
  expect(f.service.store.active(watch.id)).toBeNull();
});

it("keeps Antigravity's new integration unsupported without invoking it or reading GitHub on scan", async () => {
  const f = await setup();
  const configuration = {
    ...watchConfiguration(),
    model: { ...watchConfiguration().model, provider: "antigravity" as const },
  };
  const result = (await f.service.save({
    request_id: randomUUID(),
    name: "Unsupported",
    repository: "oppia/oppia",
    configuration,
  })) as Awaited<ReturnType<typeof f.service.store.saveRevision>>;
  const reads = f.api.mock.calls.length;
  const scan = await f.scan(result.watch.id);
  expect(scan).toMatchObject({
    status: "blocked",
    semantic_attempts: 0,
    coverage: { requests: 0 },
  });
  expect(scan.error).toContain("third-party");
  expect(f.api).toHaveBeenCalledTimes(reads);
});

it("distinguishes reentry, criteria changes, actual creation and historical unknowns", async () => {
  const f = await setup();
  const { watch } = await f.create();
  const first = await f.scan(watch.id);
  f.issues.get(1)!.state = "closed";
  const lost = await f.scan(watch.id);
  expect(
    f.service.store.candidate(watch.id, lost.id, "I_1").classification,
  ).toBe("no_longer_eligible");
  f.issues.get(1)!.state = "open";
  const returned = await f.scan(watch.id);
  expect(
    f.service.store.candidate(watch.id, returned.id, "I_1").classification,
  ).toBe("reentered");
  const baseline = f.service.store.scan(watch.id, returned.id);
  f.service.store.saveScan({ ...baseline, ended_at: "2026-10-01T00:00:00Z" });
  f.issues.set(10, { ...githubIssue(10), created_at: "2026-10-02T00:00:00Z" });
  f.issues.set(11, githubIssue(11));
  const next = await f.scan(watch.id);
  expect(
    f.service.store.candidate(watch.id, next.id, "I_10").classification,
  ).toBe("new_issue");
  expect(f.service.store.candidate(watch.id, next.id, "I_11")).toMatchObject({
    classification: "newly_matching",
    reasons: [expect.stringContaining("prior eligibility is unknown")],
  });
  f.service.store.dismiss(watch.id, "I_1", true);
  await f.service.save(
    {
      request_id: randomUUID(),
      watch_id: watch.id,
      expected_revision: 1,
      name: "New criteria",
      repository: "oppia/oppia",
      configuration: watchConfiguration("Open issues", {
        excluded_labels: ["exclude"],
      }),
    },
    true,
  );
  const changed = await f.scan(watch.id);
  expect(changed.revision).toBe(2);
  expect(f.service.store.candidate(watch.id, changed.id, "I_1")).toMatchObject({
    classification: "criteria_changed",
    dismissed_at: expect.any(String),
  });
  expect(f.service.store.scan(watch.id, first.id).revision).toBe(1);
});

it("stores claim and competing PR facts while retaining uncertainty from missing policy/timeline evidence", async () => {
  const f = await setup();
  const { watch } = await f.create();
  const issue = f.issues.get(1)!;
  issue.comments = 1;
  f.comments.set(1, [
    {
      node_id: "claim-1",
      body: "Can I work on this?",
      html_url: issue.html_url + "#issuecomment-1",
      user: { login: "alice" },
      author_association: "CONTRIBUTOR",
      created_at: issue.created_at,
      updated_at: issue.created_at,
    },
  ]);
  const claimed = await f.scan(watch.id);
  expect(f.service.store.candidate(watch.id, claimed.id, "I_1")).toMatchObject({
    claim_state: "possibly_claimed",
    classification: "manual_review",
    evidence: [
      expect.objectContaining({ kind: "claim_request", actor: "alice" }),
      expect.objectContaining({ kind: "contribution_policy" }),
    ],
  });
  f.comments.set(1, []);
  issue.comments = 0;
  f.timeline.set(1, [
    {
      event: "cross-referenced",
      source: {
        issue: {
          html_url: "https://github.com/oppia/oppia/pull/50",
          pull_request: {},
        },
      },
    },
  ]);
  f.overrides.set("repos/oppia/oppia/pulls/50", {
    node_id: "PR_50",
    html_url: "https://github.com/oppia/oppia/pull/50",
    title: "Competing change",
    body: "Fixes #1",
    state: "open",
    merged_at: null,
    updated_at: issue.updated_at,
    user: { login: "alice" },
    base: { repo: { node_id: "R_oppia" } },
  });
  const competing = await f.scan(watch.id);
  expect(
    f.service.store.candidate(watch.id, competing.id, "I_1"),
  ).toMatchObject({ eligible: false, claim_state: "competing_pr_detected" });
  f.overrides.set("repos/oppia/oppia/community/profile", () => {
    throw new Error("policy unavailable");
  });
  f.overrides.set(
    "repos/oppia/oppia/issues/2/timeline?per_page=100&page=1",
    () => {
      throw new Error("timeline unavailable");
    },
  );
  const partial = await f.scan(watch.id);
  expect(partial.status).toBe("partial");
  expect(f.service.store.candidate(watch.id, partial.id, "I_2")).toMatchObject({
    claim_state: "eligibility_uncertain",
  });
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBe(
    competing.id,
  );
});

it("preserves watch revisions, source history and baselines through actual data-root migration", async () => {
  const f = await setup();
  const { watch } = await f.create(
    watchConfiguration("Open issues", {
      trackers: [
        {
          url: "https://github.com/oppia/oppia/issues/27409",
          comments: "none",
        },
      ],
    }),
  );
  const scan = await f.scan(watch.id);
  const sources = f.service.store.sources(watch.id, scan.id);
  await f.service.close();
  await f.engine.close();
  const destination = join(f.dir, "migrated");
  await migrateDataRoot(join(f.dir, "data"), destination);
  const engine = await createFixtureEngine(destination);
  try {
    const store = new IssueWatchStore(engine.db);
    expect(store.get(watch.id).last_complete_scan_id).toBe(scan.id);
    expect(store.sources(watch.id, scan.id)).toEqual(sources);
    expect(store.revision(watch.id).configuration.rules.trackers).toHaveLength(
      1,
    );
    expect(engine.db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await engine.close();
  }
});
