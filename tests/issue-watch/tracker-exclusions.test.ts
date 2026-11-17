import { it, expect } from "vitest";

import { markdownIssueReferences } from "../../apps/core/issue-watch/tracker-exclusions";

it("parses visible Markdown references with repository identity and skips examples and PRs", () => {
  const markdown = [
    "#1 and #1, [same](https://github.com/Vibestar/Vibestar/issues/2?x=1#comment)",
    "https://github.com/other/repo/issues/1 and <https://github.com/vibestar/vibestar/issues/3>",
    "`#4` \\#5 <!-- #6 -->",
    "```md\n#7\n```",
    "[#8](https://github.com/vibestar/vibestar/pull/8) https://github.com/vibestar/vibestar/pull/9#10",
    "[reference][issue]\n\n[issue]: https://github.com/vibestar/vibestar/issues/11",
    "<div>#12</div>",
  ].join("\n\n");

  expect(markdownIssueReferences(markdown, "Vibestar/Vibestar")).toEqual([
    { repository: "vibestar/vibestar", number: 1 },
    { repository: "vibestar/vibestar", number: 11 },
    { repository: "vibestar/vibestar", number: 2 },
    { repository: "vibestar/vibestar", number: 3 },
    { repository: "other/repo", number: 1 },
  ]);
});

it("bounds reference sets and does not recursively resolve issue content", () => {
  expect(() =>
    markdownIssueReferences(
      Array.from({ length: 2001 }, (_, index) => `#${index + 1}`).join(" "),
      "vibestar/vibestar",
    ),
  ).toThrow("2,000");
});

it("recognizes closing references only in visible prose, including Markdown links", () => {
  expect(
    markdownIssueReferences(
      "Example: `Fixes #1`.\n\n```\nFixes #2\n```\n\nFixes #3 and references #4. Closes [the issue](https://github.com/vibestar/vibestar/issues/5). Resolves Other/Repo#6.",
      "vibestar/vibestar",
      true,
    ),
  ).toEqual([
    { repository: "vibestar/vibestar", number: 3 },
    { repository: "vibestar/vibestar", number: 5 },
    { repository: "other/repo", number: 6 },
  ]);
});
