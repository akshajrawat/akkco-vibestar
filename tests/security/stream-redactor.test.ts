import { expect, it } from "vitest";

import { StreamRedactor } from "../../backend/execution/output/stream-redactor";

it.each([
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "github_pat_abcdefghijklmnopqrstuvwxyz123456_ABCDEFG",
  "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
  "ya29.abcdefghijklmnopqrstuvwxyz123456",
  "Authorization: Bearer privatecredentialvalue",
  "Authorization: Bearer  \tprivatecredentialvalue",
  '"Authorization":"Bearer privatecredentialvalue"',
  '"access_token":"privatecredentialvalue"',
  "API_KEY=privatecredentialvalue",
  "Cookie: session=privatecredentialvalue; other=alsoprivate",
  "ghp_abc\x1b[31mdefghijklmnopqrstuvwxyz123456\x1b[0m",
  '"Authori\\u007aation": "Bearer privatecredentialvalue"',
  "sk\\u002dproj\\u002dabcdefghijklmnopqrstuvwxyz123456",
])("redacts every split boundary of %s", (value) => {
  for (let split = 0; split <= value.length; split++) {
    const redactor = new StreamRedactor();

    const result =
      redactor.push(`before ${value.slice(0, split)}`) +
      redactor.push(`${value.slice(split)}\r\nafter\r\n`) +
      redactor.finish();

    expect(result).toContain("[REDACTED]");

    expect(result).not.toMatch(
      /privatecredentialvalue|alsoprivate|abcdefghijklmnopqrstuvwxyz|abcdefghijk|ghp_|github_pat_|sk-proj|ya29\./,
    );

    expect(result).toContain("before ");
    expect(result).toContain("after\r\n");
  }
});

it("preserves safe live prompts, ANSI ordering and Unicode through single-character chunks", () => {
  const redactor = new StreamRedactor();
  const prompt = "\x1b[38;5;110mLogin 😀\x1b[0m: ";
  let output = "";
  for (const chunk of prompt.split("")) output += redactor.push(chunk);
  expect(output).toBe(prompt);
  expect(redactor.finish()).toBe("");
  const colored = new StreamRedactor();
  expect(colored.push("a\x1b[31mbc\x1b[0m\n") + colored.finish()).toBe("a\x1b[31mbc\x1b[0m\n");
});

it("bounds retained state across unbounded credentials and long lines and never flushes a raw ambiguous prefix", () => {
  const redactor = new StreamRedactor();
  expect(redactor.push("Authorization: Bearer ")).toBe("Authorization: [REDACTED]");
  for (let i = 0; i < 100; i++) expect(redactor.push("z".repeat(65536))).toBe("");
  expect(redactor.push("\nPrompt: ")).toBe("\nPrompt: ");
  expect(redactor.finish()).toBe("");
  const prefix = new StreamRedactor();
  expect(prefix.push("ready sk")).toBe("ready ");
  expect(prefix.finish()).toBe("[REDACTED]");
});

it("keeps session state independent and drops OSC payloads across split terminators", () => {
  const a = new StreamRedactor(),
    b = new StreamRedactor();

  expect(a.push("sk-")).toBe("[REDACTED]");
  expect(b.push("ordinary prompt: ")).toBe("ordinary prompt: ");
  expect(a.push("credentialvalue\n")).toBe("\n");
  expect(b.push("\x1b]title;privatecredentialvalue")).toBe("");
  expect(b.push("\x1b")).toBe("");
  expect(b.push("\\Visible\n")).toBe("Visible\n");
});

it("bounds ANSI-obscured prefixes and safely suppresses the remainder of an overlong ambiguous line", () => {
  const redactor = new StreamRedactor();
  const attack = "s" + "\x1b[0m".repeat(20000) + "x Authorization: Bearer privatecredentialvalue\n";
  expect(redactor.push(attack) + redactor.finish()).toBe("[REDACTED]\n");
  expect(redactor.push("Prompt: ")).toBe("Prompt: ");
});
