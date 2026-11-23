import { Linter } from "eslint";
import { expect, it } from "vitest";
import vibestar from "../../scripts/eslint-plugin-vibestar.mjs";

const linter = new Linter({ configType: "flat" });
const rule = "vibestar/no-button-border";

const config = [
  {
    files: ["**/*.tsx"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { vibestar },
    rules: { [rule]: "error" },
  },
  {
    files: ["**/*.css"],
    languageOptions: { parser: vibestar.parser },
    plugins: { vibestar },
    rules: { [rule]: "error" },
  },
] as unknown as Parameters<typeof linter.verify>[1];

const lint = (code: string, filename = "test.tsx") =>
  linter.verify(code, config, { filename }).map((message) => message.ruleId);

it.each([
  '<button className="border" />',
  '<Button className={cn("rounded-full", condition && "hover:border-red-500")} />',
  '<input type="submit" className="[border:1px_solid_red]" />',
  '<div role="switch" style={{ borderWidth: 2 }} />',
  'const styles = cva("button min-h-8", { variants: { variant: { ghost: "focus-visible:border-2" } } });',
  '<button className="[&:is(.a,_p)]:border" />',
  '<button className="[&_p,&:hover]:border" />',
  'cva("button", { compoundVariants: [{ variant: "ghost", class: "border" }] });',
  'cva("button", { compoundVariants: [{ variant: "ghost", className: "hover:border" }] });',
])("rejects button borders in %s", (code) => {
  expect(lint(code)).toEqual([rule]);
});

it("allows border resets, rounding and keyboard focus outlines", () => {
  expect(
    lint(
      '<Button className="border-0 rounded-full focus-visible:outline-2" style={{ border: 0, borderRadius: 8 }} />',
    ),
  ).toEqual([]);

  expect(lint('<div className="border"><button className="rounded-md" /></div>')).toEqual([]);
});

it("allows descendant borders and CVA selection values named border", () => {
  expect(lint('<Button className="[&_p]:border [&>svg]:border *:border **:border-2" />')).toEqual(
    [],
  );

  expect(
    lint(`cva("button", {
      variants: { variant: { border: ["rounded", "[&_p]:border"] } },
      defaultVariants: { variant: "border" },
      compoundVariants: [{ variant: ["border", "other"], className: "rounded" }],
    });`),
  ).toEqual([]);
});

it("rejects CSS button borders while allowing borders on descendants and surfaces", () => {
  expect(
    lint(
      `
    button.action { border: 0; &:hover { @apply border-2; } & > svg { border: 1px solid; } }
    .dialog .ghost-action-button { border-color: red; }
    button > svg { @apply border; }
    .card { border: 1px solid; }
    button:focus-visible { outline: 2px solid; border-radius: 4px; }
  `,
      "test.css",
    ),
  ).toEqual([rule, rule]);
});

it("splits nested selector lists only at top-level commas", () => {
  expect(
    lint(
      `
      button {
        & > svg, &:is(:not(.x, .y), [data-value="a,b"]) { border: 1px solid; }
        & > :is(svg, path), & > [data-selector=", &"] { border: 1px solid; }
        &:has(> span, > img) { @apply border; }
      }
    `,
      "test.css",
    ),
  ).toEqual([rule, rule]);
});

it.each([":is(button)", ":where(button)", ".dialog :is(a, :where(form > button))"])(
  "rejects CSS borders on %s",
  (selector) => {
    expect(lint(`${selector} { border: 1px solid; }`, "test.css")).toEqual([rule]);
  },
);

it.each([
  ":not(button)",
  ":has(button)",
  "button > svg",
  ":is(button > svg)",
  ":where(button) > svg",
  ":not(:where(button))",
  '[data-selector=":is(button)"]',
])("allows CSS borders on %s", (selector) => {
  expect(lint(`${selector} { border: 1px solid; }`, "test.css")).toEqual([]);
});
