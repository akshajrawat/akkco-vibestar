import { expect, it, vi } from "vitest";

import { GitHubClient } from "../../backend/github/client";
import { GitHubReadPool, IssueSearch } from "../../backend/github/issue-search";
import { WatchLimitsSchema } from "../../backend/issue-watch/contracts";
import { githubIssue } from "./fixtures";

it("serializes shared reads and removes cancelled waiters", async () => {
  const pool = new GitHubReadPool();
  let active = 0;
  let maximum = 0;
  const releases: (() => void)[] = [];

  const operation = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
  };

  const controllers = Array.from({ length: 7 }, () => new AbortController());

  const pending = controllers.map((controller) =>
    pool.run(operation, controller.signal).catch(() => {}),
  );

  expect(active).toBe(1);
  controllers[4].abort();
  for (let index = 0; index < 6; index++) {
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
  }

  await Promise.all(pending);
  expect(maximum).toBe(1);
  expect(active).toBe(0);
});

it("retains strict request, pagination and data budgets without fallback or automatic retries", async () => {
  const client = new GitHubClient("/tmp");
  const api = vi.spyOn(client, "api").mockResolvedValue([]);

  const reader = new IssueSearch(
    client,
    new AbortController().signal,
    WatchLimitsSchema.parse({ max_requests: 5 }),
    new GitHubReadPool(),
  );

  await expect(reader.read("https://evil.test/repos/a/b")).rejects.toThrow("only reads");
  expect(api).not.toHaveBeenCalled();
  for (let index = 0; index < 5; index++) await reader.read("repos/a/b/issues/1");
  await expect(reader.read("repos/a/b/issues/1")).rejects.toThrow("budget exhausted");
  expect(api).toHaveBeenCalledTimes(5);
  api.mockResolvedValue(Array.from({ length: 100 }, (_, id) => ({ id })));

  const paged = new IssueSearch(
    client,
    new AbortController().signal,
    WatchLimitsSchema.parse({}),
    new GitHubReadPool(),
  );

  await expect(paged.pages("repos/a/b/issues/1/comments")).rejects.toThrow("did not advance");
  expect(paged.requests).toBe(2);
  api.mockResolvedValue({ text: "a".repeat(20 * 1024 * 1024) });
  await expect(paged.read("repos/a/b/issues/1")).rejects.toThrow("20 MiB");
  api.mockRestore();
});

it.each(["duplicate", "short-page", "incomplete", "pull-request"])(
  "keeps a %s batch partial without fetching another search page",
  async (mode) => {
    const client = new GitHubClient("/tmp");
    const items = Array.from({ length: 10 }, (_, index) => githubIssue(index + 1));
    if (mode === "duplicate") items[9] = items[0];

    const api = vi.spyOn(client, "api").mockResolvedValue({
      total_count: 200,
      incomplete_results: mode === "incomplete",
      items:
        mode === "short-page"
          ? items.slice(0, 5)
          : mode === "pull-request"
            ? items.map((item, index) => (index === 0 ? { ...item, pull_request: {} } : item))
            : items,
    });

    try {
      const reader = new IssueSearch(
        client,
        new AbortController().signal,
        WatchLimitsSchema.parse({}),
        new GitHubReadPool(),
      );

      const result = await reader.discover(
        { id: "R_oppia", full_name: "oppia/oppia", url: "https://github.com/oppia/oppia" },
        "repo:oppia/oppia is:issue is:open",
      );

      expect(result.complete).toBe(false);
      expect(result.batchComplete).toBe(false);
      expect(result.nextPage).toBeNull();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(new Set(result.identities.map((item) => item.id)).size).toBe(result.identities.length);
      expect(result.identities.length).toBeLessThanOrEqual(10);
      expect(api).toHaveBeenCalledTimes(1);
    } finally {
      api.mockRestore();
    }
  },
);
