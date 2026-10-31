import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { GitHubClient } from "../../backend/github/client";
import { githubIssue, watchFixture } from "./fixtures";

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

it("advances through saved newest batches without re-fetching prior candidates, including after restart", async () => {
  const f = await setup();
  f.issues.clear();
  for (let number = 1; number <= 25; number++) f.issues.set(number, githubIssue(number));
  const { watch } = await f.create();
  const first = await f.scan(watch.id);

  expect(first).toMatchObject({
    status: "partial",
    coverage: { checked: 10 },
    batch: { order: "newest", page: 1, next_page: 2, complete: true },
  });

  expect(f.service.store.candidates(watch.id, first.id).map((c) => c.issue.number)).toEqual([
    16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
  ]);

  await f.restart();
  f.api.mockClear();

  const next = f.service.launch({
    watch_id: watch.id,
    expected_revision: 1,
    request_id: randomUUID(),
    order: "newest",
    after_scan_id: first.id,
  });

  const second = await f.finished(watch.id, next.scan_id);
  expect(second.batch).toMatchObject({ page: 2, next_page: 3, complete: true });

  expect(f.service.store.candidates(watch.id, second.id).map((c) => c.issue.number)).toEqual([
    6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);

  expect(
    f.api.mock.calls.filter(([url]) => /issues\/(?:1[6-9]|2\d)(?:\D|$)/.test(url)),
  ).toHaveLength(0);

  expect(
    f.api.mock.calls.some(([url]) => url.includes("sort=created&order=desc&per_page=10&page=2")),
  ).toBe(true);

  expect(f.service.store.results(watch.id)).toHaveLength(20);
  expect(f.service.store.get(watch.id).last_complete_scan_id).toBeNull();

  const last = f.service.launch({
    watch_id: watch.id,
    expected_revision: 1,
    request_id: randomUUID(),
    after_scan_id: second.id,
  });

  expect((await f.finished(watch.id, last.scan_id)).batch).toMatchObject({
    page: 3,
    next_page: null,
    complete: true,
  });

  expect(f.service.store.results(watch.id)).toHaveLength(25);

  expect(() =>
    f.service.launch({
      watch_id: watch.id,
      expected_revision: 1,
      request_id: randomUUID(),
      after_scan_id: last.scan_id,
    }),
  ).toThrow("no next batch");
});

it("starts oldest discovery independently and validates next-batch ownership and order", async () => {
  const f = await setup();
  f.issues.clear();
  for (let number = 1; number <= 15; number++) f.issues.set(number, githubIssue(number));
  const { watch } = await f.create();

  const start = f.service.launch({
    watch_id: watch.id,
    expected_revision: 1,
    request_id: randomUUID(),
    order: "oldest",
  });

  const scan = await f.finished(watch.id, start.scan_id);

  expect(f.service.store.candidates(watch.id, scan.id).map((c) => c.issue.number)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  ]);

  expect(
    f.api.mock.calls.some(([url]) => url.includes("sort=created&order=asc&per_page=10&page=1")),
  ).toBe(true);

  expect(() =>
    f.service.launch({
      watch_id: watch.id,
      expected_revision: 1,
      request_id: randomUUID(),
      order: "newest",
      after_scan_id: scan.id,
    }),
  ).toThrow("no next batch");

  const other = await f.create();

  expect(() =>
    f.service.launch({
      watch_id: other.watch.id,
      expected_revision: 1,
      request_id: randomUUID(),
      after_scan_id: scan.id,
    }),
  ).toThrow("does not belong");

  expect(() =>
    f.service.launch({
      watch_id: watch.id,
      expected_revision: 1,
      request_id: randomUUID(),
      candidate_ids: Array.from({ length: 11 }, (_, i) => `I_${i + 1}`),
    }),
  ).toThrow("at most 10");
});

it("stops all watch requests after a rate limit and requires an explicit retry after cooldown", async () => {
  const f = await setup();
  const { watch } = await f.create();

  const endpoint =
    "search/issues?q=repo%3Aoppia%2Foppia%20is%3Aissue%20is%3Aopen&sort=created&order=desc&per_page=10&page=1";

  f.overrides.set(endpoint, () => {
    throw new Error("GitHub CLI: You have exceeded a secondary rate limit. (HTTP 403)");
  });

  const first = await f.scan(watch.id);
  expect(first.status).toBe("blocked");
  expect(first.error).toContain("retry explicitly");
  const reads = f.api.mock.calls.length;

  const retry = (await f.service.call("retry", {
    watch_id: watch.id,
    scan_id: first.id,
    request_id: randomUUID(),
  })) as { scan_id: string };

  expect((await f.finished(watch.id, retry.scan_id)).coverage.requests).toBe(0);
  expect(f.api).toHaveBeenCalledTimes(reads);
  f.overrides.delete(endpoint);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
  expect((await f.scan(watch.id)).status).toBe("completed");
  clock.mockRestore();
});

it("persists conditional response bodies, revalidates them with GitHub and never serves them on failure", async () => {
  const f = await setup();
  const client = new GitHubClient(f.engine.root);

  const gh = vi
    .spyOn(client, "gh")
    .mockResolvedValueOnce(
      'HTTP/2.0 200 OK\r\nETag: "one"\r\nContent-Type: application/json\r\n\r\n{"title":"saved"}',
    );

  const endpoint = "repos/oppia/oppia/issues/1";

  expect(await client.api(endpoint, undefined, f.service.store.httpCache)).toEqual({
    title: "saved",
  });

  await f.restart();
  gh.mockResolvedValueOnce('HTTP/2.0 304 Not Modified\r\nETag: "one"\r\n\r\n');

  expect(await client.api(endpoint, undefined, f.service.store.httpCache)).toEqual({
    title: "saved",
  });

  expect(gh.mock.calls.at(-1)?.[0]).toContain('If-None-Match: "one"');
  gh.mockResolvedValueOnce('HTTP/2.0 200 OK\nETag: "two"\n\n{"title":"changed"}');

  expect(await client.api(endpoint, undefined, f.service.store.httpCache)).toEqual({
    title: "changed",
  });

  expect(f.service.store.httpCache.get(endpoint)?.etag).toBe('"two"');
  gh.mockRejectedValueOnce(new Error("GitHub unavailable"));

  await expect(client.api(endpoint, undefined, f.service.store.httpCache)).rejects.toThrow(
    "GitHub unavailable",
  );
});
