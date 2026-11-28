import { noDropdownBorder } from "./eslint-rules/no-dropdown-border.mjs";
import { noButtonBorder } from "./eslint-rules/no-button-border.mjs";
import { noInputBorderWithoutHover } from "./eslint-rules/no-input-border-without-hover.mjs";
import { noInputBorderOnClick } from "./eslint-rules/no-input-border-on-click.mjs";
import { noPnpm } from "./eslint-rules/no-pnpm.mjs";

const cssParser = {
  parseForESLint(code) {
    const lines = code.split("\n");

    return {
      ast: {
        type: "Program",
        start: 0,
        end: code.length,
        loc: {
          start: { line: 1, column: 0 },
          end: { line: lines.length, column: lines[lines.length - 1].length },
        },
        range: [0, code.length],
        body: [],
        tokens: [],
        comments: [],
      },
    };
  },
};

const plugin = {
  meta: {
    name: "eslint-plugin-vibestar",
    version: "0.1.0",
  },
  parser: cssParser,
  rules: {
    "no-input-border-without-hover": noInputBorderWithoutHover,
    "no-input-border-on-click": noInputBorderOnClick,
    "no-dropdown-border": noDropdownBorder,
    "no-button-border": noButtonBorder,
    "no-pnpm": noPnpm,
  },
};

export default plugin;
