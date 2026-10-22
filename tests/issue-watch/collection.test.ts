import { expect, it, vi } from "vitest";
import { GitHubClient } from "../../backend/github/client";
import { GitHubReadPool, IssueSearch } from "../../backend/github/issue-search";
import { WatchLimitsSchema } from "../../backend/issue-watch/contracts";

it("caps shared concurrent reads at four and removes cancelled waiters", async () => {
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
  expect(active).toBe(4);
  controllers[4].abort();
  releases.shift()!();
  await vi.waitFor(() => expect(releases).toHaveLength(4));
  releases.shift()!();
  await vi.waitFor(() => expect(releases).toHaveLength(4));
  for (const release of releases.splice(0)) release();
  await Promise.all(pending);
  expect(maximum).toBe(4);
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
  await expect(reader.read("https://evil.test/repos/a/b")).rejects.toThrow(
    "only reads",
  );
  expect(api).not.toHaveBeenCalled();
  for (let index = 0; index < 5; index++)
    await reader.read("repos/a/b/issues/1");
  await expect(reader.read("repos/a/b/issues/1")).rejects.toThrow(
    "budget exhausted",
  );
  expect(api).toHaveBeenCalledTimes(5);
  api.mockResolvedValue(Array.from({ length: 100 }, (_, id) => ({ id })));
  const paged = new IssueSearch(
    client,
    new AbortController().signal,
    WatchLimitsSchema.parse({}),
    new GitHubReadPool(),
  );
  await expect(paged.pages("repos/a/b/issues/1/comments")).rejects.toThrow(
    "did not advance",
  );
  expect(paged.requests).toBe(2);
  api.mockResolvedValue({ text: "a".repeat(20 * 1024 * 1024) });
  await expect(paged.read("repos/a/b/issues/1")).rejects.toThrow("20 MiB");
  api.mockRestore();
});
