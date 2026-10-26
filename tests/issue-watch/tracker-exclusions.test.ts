import { it, expect } from "vitest";

import { markdownIssueReferences } from "../../backend/issue-watch/tracker-exclusions";

it("parses visible Markdown references with repository identity and skips examples and PRs", () => {
  const markdown = [
    "#1 and #1, [same](https://github.com/Oppia/Oppia/issues/2?x=1#comment)",
    "https://github.com/other/repo/issues/1 and <https://github.com/oppia/oppia/issues/3>",
    "`#4` \\#5 <!-- #6 -->",
    "```md\n#7\n```",
    "[#8](https://github.com/oppia/oppia/pull/8) https://github.com/oppia/oppia/pull/9#10",
    "[reference][issue]\n\n[issue]: https://github.com/oppia/oppia/issues/11",
    "<div>#12</div>",
  ].join("\n\n");

  expect(markdownIssueReferences(markdown, "Oppia/Oppia")).toEqual([
    { repository: "oppia/oppia", number: 1 },
    { repository: "oppia/oppia", number: 11 },
    { repository: "oppia/oppia", number: 2 },
    { repository: "oppia/oppia", number: 3 },
    { repository: "other/repo", number: 1 },
  ]);
});

it("bounds reference sets and does not recursively resolve issue content", () => {
  expect(() =>
    markdownIssueReferences(
      Array.from({ length: 2001 }, (_, index) => `#${index + 1}`).join(" "),
      "oppia/oppia",
    ),
  ).toThrow("2,000");
});

it("recognizes closing references only in visible prose, including Markdown links", () => {
  expect(
    markdownIssueReferences(
      "Example: `Fixes #1`.\n\n```\nFixes #2\n```\n\nFixes #3 and references #4. Closes [the issue](https://github.com/oppia/oppia/issues/5). Resolves Other/Repo#6.",
      "oppia/oppia",
      true,
    ),
  ).toEqual([
    { repository: "oppia/oppia", number: 3 },
    { repository: "oppia/oppia", number: 5 },
    { repository: "other/repo", number: 6 },
  ]);
});
