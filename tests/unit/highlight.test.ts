import { expect, it } from "vitest";
import { highlightCode } from "../../apps/desktop/lib/highlight";

it("colors lexical tokens without changing or interpreting source, and bounds long-line work", () => {
  const examples = [
    ['const name = "https://example.test"; // comment', "script.ts"],
    ['<img src="x" onerror="alert(1)">', "index.html"],
    ["# a comment\nprint('hello')", "test.py"],
    [".example { color: red; }", "style.css"],
  ];

  for (const [text, path] of examples) {
    expect(
      highlightCode(text, path)
        .map((token) => token.text)
        .join(""),
    ).toBe(text);
  }

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
