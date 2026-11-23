import type { Rule, Linter } from "eslint";

export const cssParser: Linter.ParserModule;

export interface VibestarPlugin {
  meta: {
    name: string;
    version: string;
  };
  parser: Linter.ParserModule;
  rules: {
    "no-input-border-without-hover": Rule.RuleModule;
    "no-input-border-on-click": Rule.RuleModule;
    "no-dropdown-border": Rule.RuleModule;
    "no-button-border": Rule.RuleModule;
    "no-pnpm": Rule.RuleModule;
  };
}

declare const plugin: VibestarPlugin;

export default plugin;
