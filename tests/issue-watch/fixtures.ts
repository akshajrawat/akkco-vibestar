import { vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFixtureEngine } from "../helpers/fixtures";
import { GitHubClient } from "../../backend/github/client";
import { IssueWatchService } from "../../backend/issue-watch/service";
import { WatchLimitsSchema } from "../../backend/issue-watch/contracts";
import { previewRules } from "../../backend/issue-watch/rules";

export const watchConfiguration = (prompt = "Open issues", controls = {}) => {
  const preview = previewRules({ repository: "oppia/oppia", prompt, controls });
  return {
    prompt,
    rules: preview.rules,
    preview_digest: preview.digest,
    ambiguity_decisions: preview.ambiguities.map((item) => ({
      id: item.id,
      interpretation: "semantic_preference" as const,
    })),
    model: {
      provider: "codex" as const,
      model: "fixture-model",
      effort: "medium",
      timeout_secs: 120,
    },
    limits: WatchLimitsSchema.parse({}),
  };
};
export const githubIssue = (number: number, body = `Original issue ${number}`) => ({
  node_id: `I_${number}`,
  number,
  html_url: `https://github.com/oppia/oppia/issues/${number}`,
  title: `Issue ${number}`,
  body,
  state: "open",
  labels: [] as { name: string }[],
  assignees: [] as { login: string }[],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  comments: 0,
});
export const watchFixture = async (providers?: Parameters<typeof createFixtureEngine>[1]) => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-issue-watch-"));
  let engine = await createFixtureEngine(join(dir, "data"), providers);
  const client = new GitHubClient(dir);
  const issues = new Map([
    [1, githubIssue(1)],
    [2, githubIssue(2)],
    [27409, githubIssue(27409, "#2")],
  ]);
  const comments = new Map<number, unknown[]>();
  const timeline = new Map<number, unknown[]>();
  const overrides = new Map<string, unknown | (() => unknown | Promise<unknown>)>();
  const api = vi.spyOn(client, "api").mockImplementation(async (endpoint, signal) => {
    signal?.throwIfAborted();
    if (overrides.has(endpoint)) {
      const value = overrides.get(endpoint);
      return structuredClone(typeof value === "function" ? await value() : value) as never;
    }
    if (endpoint === "repos/oppia/oppia")
      return {
        node_id: "R_oppia",
        full_name: "oppia/oppia",
        html_url: "https://github.com/oppia/oppia",
      } as never;
    if (endpoint.startsWith("search/issues?"))
      return {
        total_count: issues.size,
        incomplete_results: false,
        items: [...issues.values()].map((issue) => ({
          node_id: issue.node_id,
          number: issue.number,
          html_url: issue.html_url,
        })),
      } as never;
    if (endpoint.endsWith("community/profile"))
      return {
        files: {
          contributing: {
            url: "https://api.github.com/repos/oppia/oppia/contents/CONTRIBUTING.md",
          },
        },
      } as never;
    if (endpoint === "repos/oppia/oppia/contents/CONTRIBUTING.md")
      return {
        type: "file",
        sha: "policy-sha",
        html_url: "https://github.com/oppia/oppia/blob/main/CONTRIBUTING.md",
        content: Buffer.from("Keep changes focused and discuss unclear requirements.").toString(
          "base64",
        ),
        encoding: "base64",
        size: 60,
      } as never;
    const match = endpoint.match(
      /^repos\/oppia\/oppia\/issues\/(\d+)(?:\/(comments|timeline)\?per_page=100&page=(\d+))?$/,
    );
    if (match) {
      const number = Number(match[1]);
      if (match[2])
        return (
          Number(match[3]) === 1
            ? (match[2] === "comments" ? comments.get(number) : timeline.get(number)) || []
            : []
        ) as never;
      const value = issues.get(number);
      if (!value) throw new Error("Fixture GitHub 404");
      return structuredClone(value) as never;
    }
    throw new Error(`Unconfigured fixture endpoint: ${endpoint}`);
  });
  let service = new IssueWatchService(engine, client);
  const create = async (configuration = watchConfiguration()) => {
    const result = await service.save({
      request_id: randomUUID(),
      name: "Oppia opportunities",
      repository: "https://github.com/Oppia/Oppia",
      configuration,
    });
    return result as Awaited<ReturnType<typeof service.store.saveRevision>>;
  };
  const finished = async (watchId: string, scanId: string) => {
    await vi.waitFor(() => expectTerminal(service.store.scan(watchId, scanId).status), {
      timeout: 10000,
    });
    return service.store.scan(watchId, scanId);
  };
  const scan = async (watchId: string) => {
    const operation = service.launch({
      watch_id: watchId,
      expected_revision: service.store.get(watchId).current_revision,
      request_id: randomUUID(),
    });
    return finished(watchId, operation.scan_id);
  };
  return {
    dir,
    issues,
    comments,
    timeline,
    overrides,
    api,
    create,
    finished,
    scan,
    get engine() {
      return engine;
    },
    get service() {
      return service;
    },
    restart: async () => {
      await service.close();
      await engine.close();
      engine = await createFixtureEngine(join(dir, "data"), providers);
      service = new IssueWatchService(engine, client);
    },
    close: async () => {
      await service.close();
      await engine.close();
      await rm(dir, { recursive: true, force: true });
      api.mockRestore();
    },
  };
};
const expectTerminal = (status: string) => {
  if (status === "running" || status === "cancelling") throw new Error("Scan is still active.");
};
