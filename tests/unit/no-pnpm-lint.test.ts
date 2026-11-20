import { describe, it, expect, vi } from "vitest";
import { Linter } from "eslint";
import fs from "node:fs";
import vibestar from "../../scripts/eslint-plugin-vibestar.mjs";

describe("no-pnpm lint rule", () => {
  const linter = new Linter({ configType: "flat" });

  const config = [
    {
      files: ["**/*.{ts,tsx,js,mjs}"],
      languageOptions: {
        parserOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
        },
      },
      plugins: { vibestar },
      rules: {
        "vibestar/no-pnpm": "error",
      },
    },
  ] as unknown as Parameters<typeof linter.verify>[1];

  it("reports an error when pnpm lockfile or workspace file exists", () => {
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("pnpm-lock.yaml");
    });

    const messages = linter.verify("const x = 1;", config, { filename: "sample.ts" });
    expect(messages.map((m) => m.ruleId)).toContain("vibestar/no-pnpm");
    expect(messages[0].message).toContain('pnpm is forbidden. Found "pnpm-lock.yaml"');
    existsSpy.mockRestore();
  });

  it("allows pnpm mentioned in strings or code without error", () => {
    const code = 'const cmd = "pnpm install";';
    const messages = linter.verify(code, config, { filename: "sample.ts" });
    expect(messages).toEqual([]);
  });

  it("passes when no pnpm files exist", () => {
    const code = 'const cmd = "npm run build";';
    const messages = linter.verify(code, config, { filename: "sample.ts" });
    expect(messages).toEqual([]);
  });
});
