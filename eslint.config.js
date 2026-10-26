import js from "@eslint/js";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import stylistic from "@stylistic/eslint-plugin";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-core/**",
      "dist-electron/**",
      "release/**",
      "coverage/**",
      "test-results/**",
      ".husky/_/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-control-regex": "off",
      "@typescript-eslint/consistent-type-imports": ["error", { disallowTypeAnnotations: false }],
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
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
);
