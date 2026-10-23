import { expect, it } from "vitest";
import {
  parseUnifiedDiff,
  sourceLines,
  splitDiffRows,
} from "../../src/lib/diff/parse";
import { highlightCode } from "../../src/lib/diff/highlight";

const patch =
  "@@ -1,4 +1,5 @@ function example\n start\n-const value = 1;\n+const value = 2;\n+console.log(value);\n return value;\n end\n";
it("maps replacement, insertion and unchanged lines accurately in unified and split rows", () => {
  const parsed = parseUnifiedDiff(patch);
  expect(parsed.reason).toBeNull();
  expect(
    parsed.hunks[0].lines.map((line) => [
      line.kind,
      line.oldLine,
      line.newLine,
    ]),
  ).toEqual([
    ["context", 1, 1],
    ["delete", 2, null],
    ["add", null, 2],
    ["add", null, 3],
    ["context", 3, 4],
    ["context", 4, 5],
  ]);
  expect(
    splitDiffRows(parsed.hunks[0].lines).map((row) => [
      row.base?.oldLine,
      row.working?.newLine,
    ]),
  ).toEqual([
    [1, 1],
    [2, 2],
    [undefined, 3],
    [3, 4],
    [4, 5],
  ]);
});

it.each([
  [
    "@@ -0,0 +1,2 @@\n+one\n+two\n",
    [
      [null, 1],
      [null, 2],
    ],
  ],
  [
    "@@ -1,2 +0,0 @@\n-one\n-two\n",
    [
      [1, null],
      [2, null],
    ],
  ],
  [
    "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
    [
      [1, null],
      [null, null],
      [null, 1],
      [null, null],
    ],
  ],
] as const)(
  "handles zero ranges and absent final newlines: %s",
  (patch, expected) => {
    const parsed = parseUnifiedDiff(patch);
    expect(parsed.reason).toBeNull();
    expect(
      parsed.hunks[0].lines.map((line) => [line.oldLine, line.newLine]),
    ).toEqual(expected);
  },
);

it("rejects inconsistent counts, overlapping hunks, unsafe counters and multi-file patches instead of inventing line mappings", () => {
  for (const patch of [
    "@@ -1,2 +1 @@\n-old\n+new\n",
    "@@ -1 +1 @@\n-a\n+b\n@@ -1 +2 @@\n-a\n+b\n",
    "@@ -999999999999999999999 +1 @@\n-a\n+b\n",
    "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\n",
  ]) {
    expect(parseUnifiedDiff(patch).reason).toBe("unrecognized");
  }
  expect(parseUnifiedDiff("x".repeat(750001)).reason).toBe("oversized");
  expect(parseUnifiedDiff("\n".repeat(12001)).reason).toBe("oversized");
});

it("retains rename-only and permission-only metadata, CRLF text and real blank source lines", () => {
  expect(
    parseUnifiedDiff(
      "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n",
    ),
  ).toEqual({ hunks: [], reason: null });
  expect(sourceLines("a\r\n\r\n")).toEqual(["a", ""]);
  expect(sourceLines("")).toEqual([]);
  expect(sourceLines("a")).toEqual(["a"]);
});

it("colors lexical tokens without changing or interpreting source, and bounds long-line work", () => {
  const examples = [
    ['const name = "https://example.test"; // comment', "script.ts"],
    ['<img src="x" onerror="alert(1)">', "index.html"],
    ["# a comment\nprint('hello')", "test.py"],
    [".example { color: red; }", "style.css"],
  ];
  for (const [text, path] of examples)
    expect(
      highlightCode(text, path)
        .map((token) => token.text)
        .join(""),
    ).toBe(text);
  expect(highlightCode(examples[0][0], "script.ts")).toContainEqual({
    kind: "keyword",
    text: "const",
  });
  expect(highlightCode("const ".repeat(1000), "large.ts")).toEqual([
    { kind: "text", text: "const ".repeat(1000) },
  ]);
  expect(highlightCode("plain text", "readme.unknown")).toEqual([
    { kind: "text", text: "plain text" },
  ]);
});
