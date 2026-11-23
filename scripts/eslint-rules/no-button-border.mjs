import {
  checkCssBorders,
  extractTokens,
  hasBorderUtility,
  showsBorder,
  splitVariants,
} from "./no-input-border-on-click.mjs";

const buttonClass = /^\.(?:[\w-]+-)?button\b(?!-)/;

const buttonSelector = {
  test(selector) {
    return selector
      .replace(/\[role\s*=\s*["']?(?:button|switch)["']?\s*\]/g, ".button")
      .replace(/\[[^\]]*\]|\([^()]*\)/g, "")
      .split(",")
      .some((item) => {
        const element = item
          .trim()
          .split(/[\s>+~]+/)
          .at(-1);

        return (
          /^button\b(?!-)/.test(element) ||
          element.split(/(?=\.)/).some((part) => buttonClass.test(part))
        );
      });
  },
};

const isBorder = (token) => {
  const base = splitVariants(token).at(-1).replace(/^!|!$/g, "");
  return /^\[?border(?:$|[-:])/.test(base) && hasBorderUtility(base);
};

const visibleBorder = (name, value) => /^border\b/i.test(name) && showsBorder(name, value);

const variantTokens = (node) =>
  node?.type === "ObjectExpression"
    ? node.properties.flatMap((property) => variantTokens(property.value))
    : node?.type === "ArrayExpression"
      ? node.elements.flatMap(variantTokens)
      : extractTokens(node);

export const noButtonBorder = {
  meta: {
    type: "problem",
    schema: [],
    messages: { noButtonBorder: 'Buttons must be borderless (found "{{token}}").' },
  },
  create(context) {
    const messageId = "noButtonBorder";
    if (context.filename.endsWith(".css")) {
      return {
        Program() {
          checkCssBorders(context, {
            target: buttonSelector,
            utility: isBorder,
            declaration: visibleBorder,
            messageId,
            inheritsTarget: (selector) =>
              /^\s*@/.test(selector) || /^\s*&[^\s>+~]*\s*$/.test(selector),
          });
        },
      };
    }

    const reportTokens = (node, tokens) => {
      for (const token of tokens.filter(isBorder)) {
        context.report({ node, messageId, data: { token } });
      }
    };

    return {
      JSXOpeningElement(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : node.name.property?.name;

        const attribute = (key) =>
          node.attributes.find((attr) => attr.type === "JSXAttribute" && attr.name.name === key)
            ?.value;

        const role = attribute("role")?.value;
        const type = attribute("type")?.value;
        if (
          !/^(?:button|.*Button)$/.test(name) &&
          !["button", "switch"].includes(role) &&
          !(name === "input" && ["button", "submit", "reset"].includes(type))
        ) {
          return;
        }

        reportTokens(node, extractTokens(attribute("className") ?? attribute("class")));
        const style = attribute("style")?.expression;
        if (style?.type === "ObjectExpression") {
          for (const prop of style.properties) {
            const key = prop.key?.name ?? prop.key?.value;
            if (typeof key !== "string") {
              continue;
            }

            const css = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

            const value =
              prop.value.type === "Literal" ? String(prop.value.value ?? "none") : "expression";

            if (visibleBorder(css, value)) {
              context.report({ node: prop, messageId, data: { token: key } });
            }
          }
        }
      },
      CallExpression(node) {
        if (node.callee.name !== "cva") {
          return;
        }

        const [base, config] = node.arguments;
        const tokens = extractTokens(base);
        if (tokens.includes("button")) {
          reportTokens(node, [...tokens, ...variantTokens(config)]);
        }
      },
    };
  },
};
