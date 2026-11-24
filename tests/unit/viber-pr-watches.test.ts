import { describe, expect, it } from "vitest";

import {
  canonicalPullRequest,
  parsePullRequest,
  parseWatchCommand,
  isWatchCommand,
  type PrWatchCursor,
} from "../../apps/core/github/contracts";
import { compareCursors } from "../../apps/core/github/pr-watches";

describe("PR Watch Contracts & Parser", () => {
  it("canonicalizes pull request URLs and lowercases owner and repo", () => {
    const canonical = canonicalPullRequest("https://github.com/OwnerName/RepoName/pull/42");

    expect(canonical).toEqual({
      owner: "ownername",
      repo: "reponame",
      number: 42,
      url: "https://github.com/ownername/reponame/pull/42",
    });

    const trailing = canonicalPullRequest("  https://github.com/OwnerName/RepoName/pull/42/  ");
    expect(trailing).toEqual(canonical);
  });

  it("safely rejects malformed, non-GitHub, or insecure PR URLs", () => {
    const invalidInputs = [
      "",
      "foo",
      "http://github.com/owner/repo/pull/42",
      "https://gitlab.com/owner/repo/pull/42",
      "https://github.com/owner/repo/issues/42",
      "https://github.com/owner/repo/pull/0",
      "https://github.com/owner/repo/pull/-5",
      "https://github.com/owner/../pull/42",
      "https://user:pass@github.com/owner/repo/pull/42",
      "https://github.com:8080/owner/repo/pull/42",
      "https://github.com/owner/repo/pull/42?query=1",
      "https://github.com/owner/repo/pull/42#hash",
    ];

    for (const input of invalidInputs) {
      expect(() => parsePullRequest(input)).toThrow(
        /Use an HTTPS github\.com\/owner\/repository\/pull\/number URL/,
      );

      expect(() => canonicalPullRequest(input)).toThrow(
        /Use an HTTPS github\.com\/owner\/repository\/pull\/number URL/,
      );
    }
  });

  it("parses chat watch commands and aliases", () => {
    expect(isWatchCommand("/watch https://github.com/o/r/pull/1")).toBe(true);
    expect(isWatchCommand("  /watches  ")).toBe(true);
    expect(isWatchCommand("/unwatch 123")).toBe(true);
    expect(isWatchCommand("/clear")).toBe(false);
    expect(isWatchCommand("hello")).toBe(false);

    expect(parseWatchCommand("/watch https://github.com/owner/repo/pull/10")).toEqual({
      type: "create",
      url: "https://github.com/owner/repo/pull/10",
    });

    expect(parseWatchCommand("/watch create https://github.com/owner/repo/pull/10")).toEqual({
      type: "create",
      url: "https://github.com/owner/repo/pull/10",
    });

    expect(parseWatchCommand("/watch add https://github.com/owner/repo/pull/10")).toEqual({
      type: "create",
      url: "https://github.com/owner/repo/pull/10",
    });

    expect(parseWatchCommand("/watch list")).toEqual({ type: "list" });
    expect(parseWatchCommand("/watches")).toEqual({ type: "list" });
    expect(parseWatchCommand("/watches list")).toEqual({ type: "list" });

    expect(parseWatchCommand("/watch cancel https://github.com/owner/repo/pull/10")).toEqual({
      type: "cancel",
      target: "https://github.com/owner/repo/pull/10",
    });

    expect(parseWatchCommand("/unwatch https://github.com/owner/repo/pull/10")).toEqual({
      type: "cancel",
      target: "https://github.com/owner/repo/pull/10",
    });

    expect(parseWatchCommand("/unwatch")).toEqual({
      type: "help",
      message: "Usage: /unwatch <pr-url | watch-id>",
    });

    expect(parseWatchCommand("/watch help")).toEqual({ type: "help" });
    expect(parseWatchCommand("/watch")).toEqual({ type: "help" });
  });

  it("detects meaningful diffs between PR cursors", () => {
    const base: PrWatchCursor = {
      state: "OPEN",
      draft: true,
      head_sha: "abc111",
      review_decision: null,
      check_status: null,
      mergeable: "UNKNOWN",
      updated_at: "2026-01-01T00:00:00Z",
    };

    // No changes when only head_sha changes silently
    const silentCommit: PrWatchCursor = {
      ...base,
      head_sha: "abc222",
      updated_at: "2026-01-01T01:00:00Z",
    };

    expect(compareCursors(base, silentCommit)).toEqual([]);

    // Ready for review
    const ready: PrWatchCursor = {
      ...base,
      draft: false,
    };

    expect(compareCursors(base, ready)).toEqual(["Marked ready for review"]);

    // Review changes
    const approved: PrWatchCursor = {
      ...base,
      review_decision: "APPROVED",
    };

    expect(compareCursors(base, approved)).toEqual(["Reviews approved"]);

    const changesRequested: PrWatchCursor = {
      ...base,
      review_decision: "CHANGES_REQUESTED",
    };

    expect(compareCursors(base, changesRequested)).toEqual(["Changes requested by reviewer"]);

    // Check changes
    const checksPassed: PrWatchCursor = {
      ...base,
      check_status: "SUCCESS",
    };

    expect(compareCursors(base, checksPassed)).toEqual(["All checks passed"]);

    const checksFailed: PrWatchCursor = {
      ...base,
      check_status: "FAILURE",
    };

    expect(compareCursors(base, checksFailed)).toEqual(["Checks failed"]);

    // Conflicts
    const conflict: PrWatchCursor = {
      ...base,
      mergeable: "CONFLICTING",
    };

    expect(compareCursors(base, conflict)).toEqual(["Merge conflict detected"]);

    const resolved: PrWatchCursor = {
      ...conflict,
      mergeable: "MERGEABLE",
    };

    expect(compareCursors(conflict, resolved)).toEqual(["Merge conflict resolved"]);

    // UNKNOWN never implies conflict or resolution
    const unknownMergeable: PrWatchCursor = {
      ...conflict,
      mergeable: "UNKNOWN",
    };

    expect(compareCursors(conflict, unknownMergeable)).toEqual([]);

    // Lifecycle transitions
    const merged: PrWatchCursor = {
      ...base,
      state: "MERGED",
    };

    expect(compareCursors(base, merged)).toEqual(["Merged into base branch"]);

    const closed: PrWatchCursor = {
      ...base,
      state: "CLOSED",
    };

    expect(compareCursors(base, closed)).toEqual(["Closed without merge"]);
  });
});
