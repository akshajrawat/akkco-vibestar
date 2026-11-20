import js from "@eslint/js";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import stylistic from "@stylistic/eslint-plugin";
import vibestar from "./scripts/eslint-plugin-vibestar.mjs";

export default tseslint.config(
  {
    ignores: ["out/**", "coverage/**", ".husky/_/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    rules: {
      curly: ["error", "all"],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    plugins: { vibestar },
    rules: {
      "vibestar/no-pnpm": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { vibestar },
    rules: {
      "no-control-regex": "off",
      "vibestar/no-input-border-without-hover": "error",
      "vibestar/no-input-border-on-click": "error",
      "vibestar/no-dropdown-border": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.css"],
    languageOptions: {
      parser: vibestar.parser,
    },
    plugins: { vibestar },
    rules: {
      "vibestar/no-input-border-without-hover": "error",
      "vibestar/no-input-border-on-click": "error",
      "vibestar/no-dropdown-border": "error",
    },
  },
  {
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/lines-between-class-members": ["error", "always"],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "import", next: "*" },
        { blankLine: "any", prev: "import", next: "import" },
        { blankLine: "always", prev: ["class", "function"], next: "*" },
        { blankLine: "always", prev: "*", next: ["class", "function"] },
        { blankLine: "always", prev: ["interface", "type"], next: "*" },
        { blankLine: "always", prev: "*", next: ["interface", "type"] },
        { blankLine: "always", prev: "multiline-export", next: "*" },
        { blankLine: "always", prev: "*", next: "multiline-export" },
        { blankLine: "always", prev: "multiline-const", next: "*" },
        { blankLine: "always", prev: "*", next: "multiline-const" },
        { blankLine: "always", prev: "multiline-expression", next: "*" },
        { blankLine: "always", prev: "*", next: "multiline-expression" },
        { blankLine: "always", prev: "block-like", next: "*" },
      ],
    },
  },
  {
    files: ["apps/desktop/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message:
                "Renderer must not import Electron runtime directly. Use window.vibestar and window.electronWindow.",
            },
          ],
          patterns: [
            {
              group: ["**/electron/main*", "**/electron/bridge*", "**/electron/window-controls*"],
              message:
                "Renderer must not import Electron main-process code. Use window.vibestar and window.electronWindow.",
            },
            {
              group: [
                "**/core/execution/runtime/**",
                "**/core/execution/engine/**",
                "**/core/execution/agents/**",
                "**/core/storage/database*",
                "**/core/storage/migrations*",
                "**/core/storage/service*",
                "**/core/rpc/**",
                "node:fs*",
                "node:child_process*",
              ],
              message: "Renderer must not import backend runtime implementations.",
            },
          ],
        },
      ],
    },
  },
);
