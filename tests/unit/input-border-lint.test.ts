import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
import vibestar from "../../scripts/eslint-plugin-vibestar.mjs";

describe("input border lint checks", () => {
  const linter = new Linter({ configType: "flat" });

  const config = [
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parserOptions: {
          ecmaFeatures: { jsx: true },
          ecmaVersion: "latest",
          sourceType: "module",
        },
      },
      plugins: { vibestar },
      rules: {
        "vibestar/no-input-border-without-hover": "error",
        "vibestar/no-input-border-on-click": "error",
        "vibestar/no-dropdown-border": "error",
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
  ] as unknown as Parameters<typeof linter.verify>[1];

  const lint = (code: string) => {
    return linter.verify(code, config, { filename: "test.tsx" });
  };

  const lintCss = (code: string) => {
    return linter.verify(code, config, { filename: "test.css" });
  };

  it("rejects dropdown borders in JSX and CSS while allowing rounding and keyboard outlines", () => {
    for (const code of [
      '<select className="hover:border-2" />',
      '<button role="combobox" className="[border-color:white]" />',
      '<div className={`select-popover ${open && "border"}`} />',
    ]) {
      expect(lint(code).map((message) => message.ruleId)).toEqual(["vibestar/no-dropdown-border"]);
    }

    expect(lint('<select className="rounded-lg border-0 focus-visible:outline" />')).toEqual([]);

    expect(
      lintCss(`
        .select-trigger { border-width: 0; border-radius: 8px; &:hover { border: 1px solid; } }
        .select-popover { @apply border-0 rounded-lg; }
        select { @apply focus:border-b-2; }
      `).map((message) => message.ruleId),
    ).toEqual(["vibestar/no-dropdown-border", "vibestar/no-dropdown-border"]);
  });

  it("passes when inputs do not use borders or include hover interactions without focus borders", () => {
    const validSnippets = [
      '<input placeholder="Name" />',
      '<input className="bg-input px-3 py-2 rounded-md" />',
      '<input className="border border-slate-700 hover:border-slate-500 focus:outline-none" />',
      '<input className="border hover:bg-neutral-800 focus:ring-2 focus:ring-blue-500" />',
      '<input className="border-0 bg-transparent focus:border-0" />',
      '<input className="border-none focus:border-none active:border-s-0" />',
      '<textarea className="active:[border-color:transparent] focus:[outline-width:0px]" />',
      '<input type="hidden" className="border focus:border-red-500" />',
      '<textarea className="border hover:border-blue-500 focus:outline-none" />',
      '<Input className="border hover:border-accent" />',
      '<input className={cn("border", isHovered && "hover:border-white")} />',
      '<input style={{ border: "none" }} />',
      '<div className="border focus:border-blue-500" />',
    ];

    for (const snippet of validSnippets) {
      const messages = lint(snippet);
      expect(messages, `Expected snippet to be valid: ${snippet}`).toHaveLength(0);
    }
  });

  it("throws an error when an input uses border without a hover state", () => {
    const invalidSnippets = [
      '<input className="border" />',
      '<input className="border border-slate-700" />',
      '<input className="border-2 border-red-500" />',
      '<textarea className="border" />',
      '<Input className="border border-border" />',
      '<input style={{ border: "1px solid red" }} />',
      '<input className={cn("border", disabled && "opacity-50")} />',
    ];

    for (const snippet of invalidSnippets) {
      const messages = lint(snippet);
      expect(messages, `Expected snippet to trigger an error: ${snippet}`).toHaveLength(1);
      expect(messages[0].ruleId).toBe("vibestar/no-input-border-without-hover");
      expect(messages[0].message).toContain("Input box uses border without a hover state");
    }
  });

  it("throws an error when an input uses border on click or focus", () => {
    const invalidSnippets = [
      {
        code: '<input className="focus:border-blue-500" />',
        token: "focus:border-blue-500",
      },
      {
        code: '<input className="focus:border" />',
        token: "focus:border",
      },
      {
        code: '<input className="active:border-red-500" />',
        token: "active:border-red-500",
      },
      {
        code: '<div className="[&_input:active]:border"><input /></div>',
        token: "[&_input:active]:border",
      },
      {
        code: '<input className="group-active/card:border-b-2!" />',
        token: "group-active/card:border-b-2!",
      },
      {
        code: '<textarea className="[&:is(:active,:focus)]:[border-inline-start-width:2px]" />',
        token: "[&:is(:active,:focus)]:[border-inline-start-width:2px]",
      },
      {
        code: '<input className="focus-visible:border-primary" />',
        token: "focus-visible:border-primary",
      },
      {
        code: '<textarea className="focus:border-white" />',
        token: "focus:border-white",
      },
      {
        code: '<Input className="focus:border-2" />',
        token: "focus:border-2",
      },
      {
        code: '<input className={cn("hover:border-white", isFocused && "focus:border-blue-500")} />',
        token: "focus:border-blue-500",
      },
    ];

    for (const { code, token } of invalidSnippets) {
      const messages = lint(code);
      const onClickMessage = messages.find((m) => m.ruleId === "vibestar/no-input-border-on-click");
      expect(onClickMessage, `Expected border on click error for: ${code}`).toBeDefined();
      expect(onClickMessage?.message).toContain(`found "${token}"`);
      expect(onClickMessage?.message).toContain("active or focused state");
    }
  });

  it("lints CSS files and catches on-click borders or missing hover states", () => {
    const validCss = `
      input {
        border: 0;
        background: #111;
      }
      input:hover {
        background: #222;
      }
      input:focus,
      input:focus-visible {
        outline: none;
        border: 0;
      }
    `;

    expect(lintCss(validCss)).toHaveLength(0);

    const invalidFocusOutline = `
      .viber-profile-editor input:focus-visible {
        outline: 1px solid var(--focus-ring);
        outline-offset: 2px;
      }
    `;

    const focusMessages = lintCss(invalidFocusOutline);
    expect(focusMessages).toHaveLength(1);
    expect(focusMessages[0].ruleId).toBe("vibestar/no-input-border-on-click");
    expect(focusMessages[0].message).toContain("active or focused state");

    const activeMessages = lintCss(`
      @media (width >= 300px) {
        input:active { border-block-start-width: 2px; }
        .chat-input:has(textarea:active) { @apply [border-color:white] border-0; }
        textarea { @apply active:border-t-2 focus:ring-2; }
        textarea { color: white; &:active { border-color: white; } }
      }
    `);

    expect(activeMessages.map(({ ruleId }) => ruleId)).toEqual(
      Array(4).fill("vibestar/no-input-border-on-click"),
    );

    const invalidMissingHover = `
      .my-panel input {
        border: 1px solid #444;
      }
    `;

    const hoverMessages = lintCss(invalidMissingHover);
    expect(hoverMessages).toHaveLength(1);
    expect(hoverMessages[0].ruleId).toBe("vibestar/no-input-border-without-hover");
  });
});
