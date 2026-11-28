import fs from "node:fs";
import { basename } from "node:path";
import { Linter } from "eslint";
import { afterEach, describe, it, expect, vi } from "vitest";

import vibestar from "../../scripts/eslint-plugin-vibestar.mjs";

afterEach(() => vi.restoreAllMocks());

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

  it("reports both pnpm file types when present", () => {
    const pnpmFiles = ["pnpm-lock.yaml", "pnpm-workspace.yaml"];

    vi.spyOn(fs, "existsSync").mockImplementation((path) =>
      pnpmFiles.includes(basename(String(path))),
    );

    const messages = linter.verify("const x = 1;", config, { filename: "sample.ts" });

    expect(messages).toMatchObject(
      pnpmFiles.map((file) => ({
        ruleId: "vibestar/no-pnpm",
        message: expect.stringContaining(`pnpm is forbidden. Found "${file}"`),
      })),
    );
  });

  it("passes when no pnpm files exist, even if code mentions pnpm", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const code = 'const cmd = "pnpm install";';
    const messages = linter.verify(code, config, { filename: "sample.ts" });
    expect(messages).toEqual([]);
  });
});
