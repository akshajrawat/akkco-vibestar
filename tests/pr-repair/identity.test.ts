import { expect, it, vi } from "vitest";

import { PRIdentityReader } from "../../backend/review/repair/identity";
import { GitHubClient } from "../../backend/github/client";

it("reads immutable PR/fork IDs, the actual head/base refs, current base SHA and official authenticated push permission", async () => {
  const client = new GitHubClient("/tmp");

  const upstream = {
    node_id: "R_upstream",
    full_name: "oppia/oppia",
    clone_url: "https://github.com/oppia/oppia.git",
  };

  const head = {
    node_id: "R_fork",
    full_name: "akshajrawat/oppia",
    clone_url: "https://github.com/akshajrawat/oppia.git",
    permissions: { push: true },
  };

  const metadata = {
    node_id: "PR_27527",
    number: 27527,
    html_url: "https://github.com/oppia/oppia/pull/27527",
    state: "open",
    head: { ref: "fix/translation-tests", sha: "a".repeat(40), repo: head },
    base: { ref: "develop", sha: "b".repeat(40), repo: upstream },
  };

  const api = vi
    .spyOn(client, "api")
    .mockImplementation(async (endpoint) =>
      endpoint.endsWith("/pulls/27527")
        ? metadata
        : endpoint === "user"
          ? { login: "akshajrawat" }
          : endpoint.includes("git/ref/")
            ? { object: { sha: "c".repeat(40) } }
            : head,
    );

  const reader = new PRIdentityReader(client);
  const identity = await reader.read(metadata.html_url, new AbortController().signal);

  expect(identity).toMatchObject({
    id: "PR_27527",
    head: {
      id: "R_fork",
      branch: "fix/translation-tests",
      sha: "a".repeat(40),
    },
    base: { branch: "develop", sha: "c".repeat(40) },
    viewer: "akshajrawat",
    can_push: true,
  });

  expect(api.mock.calls.some(([endpoint]) => endpoint.endsWith("git/ref/heads/develop"))).toBe(
    true,
  );

  metadata.head.repo = { ...head, node_id: "R_unrelated" };

  await expect(reader.read(metadata.html_url, new AbortController().signal)).rejects.toThrow(
    "inconsistent",
  );

  metadata.head.repo = head;
  metadata.head.ref = "--upload-pack=malicious";

  await expect(reader.read(metadata.html_url, new AbortController().signal)).rejects.toThrow(
    "invalid branch",
  );

  metadata.head.ref = "fix/translation-tests";
  head.clone_url = "https://example.invalid/attacker.git";

  await expect(reader.read(metadata.html_url, new AbortController().signal)).rejects.toThrow(
    "unexpected repository transport",
  );

  vi.restoreAllMocks();
});
