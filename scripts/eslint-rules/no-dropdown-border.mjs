import {
  checkCssBorders,
  extractTokens,
  hasBorderUtility,
  showsBorder,
  splitVariants,
} from "./no-input-border-on-click.mjs";

const dropdownSelector =
  /\.(?:select-trigger|select-popover|select-search|viber-model-popover)\b|(?:^|[\s,>+~])select(?=[\s,.#:[>+~]|$)|\[role\s*=\s*["']?(?:combobox|listbox|menu)["']?\]/;

const messageId = "noDropdownBorder";

const isBorderUtility = (token) => {
  const base = splitVariants(token).at(-1).replace(/^!|!$/g, "");
  return /^\[?border(?:$|[-:])/.test(base) && hasBorderUtility(base);
};

export const noDropdownBorder = {
  meta: {
    type: "problem",
    schema: [],
    messages: { noDropdownBorder: 'Dropdowns must be borderless (found "{{token}}").' },
  },
  create(context) {
    if (context.filename.endsWith(".css")) {
      return {
        Program() {
          checkCssBorders(context, {
            target: dropdownSelector,
            utility: isBorderUtility,
            declaration: (name, value) => /^border\b/i.test(name) && showsBorder(name, value),
            messageId,
          });
        },
      };
    }

    return {
      JSXOpeningElement(node) {
        const tokens = node.attributes.flatMap((attr) =>
          attr.type === "JSXAttribute" && attr.name.name === "className"
            ? extractTokens(attr.value)
            : [],
        );

        const name =
          node.name.type === "JSXIdentifier"
            ? node.name.name
            : node.name.type === "JSXMemberExpression"
              ? node.name.property.name
              : "";

        const dropdown =
          ["select", "Select"].includes(name) ||
          tokens.some((token) => dropdownSelector.test("." + token)) ||
          node.attributes.some(
            (attr) =>
              attr.type === "JSXAttribute" &&
              ["role", "aria-haspopup"].includes(attr.name.name) &&
              ["combobox", "listbox", "menu"].includes(attr.value?.value),
          );

        for (const token of tokens) {
          if (dropdown && isBorderUtility(token)) {
            context.report({ node, messageId, data: { token } });
          }
        }
      },
    };
  },
};
