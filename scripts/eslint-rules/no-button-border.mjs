import {
  checkCssBorders,
  extractTokens,
  hasBorderUtility,
  showsBorder,
  splitVariants,
} from "./no-input-border-on-click.mjs";

const buttonClass = /^\.(?:[\w-]+-)?button\b(?!-)/;

const splitSelector = (selector, delimiter) => {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === "\\") {
      i++;
    } else if (quote) {
      if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "(") {
      depth++;
    } else if (char === "]" || char === ")") {
      depth--;
    } else if (depth === 0 && delimiter.test(char)) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }

  return [...parts, selector.slice(start).trim()].filter(Boolean);
};

const lastCompound = (selector) => splitSelector(selector, /[\s>+~]/).at(-1) ?? "";

const buttonSelector = {
  test(selector) {
    return splitSelector(selector, /,/).some((item) => {
      const element = lastCompound(item)
        .replace(/\[role\s*=\s*["']?(?:button|switch)["']?\s*\]/g, ".button")
        .replace(/\[[^\]]*\]|\((?:[^()]|\([^()]*\))*\)/g, "");

      return (
        /^button\b(?!-)/.test(element) ||
        element.split(/(?=\.)/).some((part) => buttonClass.test(part))
      );
    });
  },
};

const targetsOtherElement = (variant) => {
  if (variant === "*" || variant === "**") {
    return true;
  }

  if (!variant.startsWith("[") || variant.startsWith("[@")) {
    return false;
  }

  const selectors = splitSelector(
    variant.slice(1, -1).replace(/\\_|_/g, (char) => (char === "_" ? " " : char)),
    /,/,
  );

  return (
    selectors.length > 0 &&
    selectors.every(
      (selector) =>
        /^[>+~]/.test(selector) ||
        (selector.startsWith("&") && !lastCompound(selector).startsWith("&")),
    )
  );
};

const isBorder = (token) => {
  const parts = splitVariants(token);
  const base = parts.pop().replace(/^!|!$/g, "");
  return (
    /^\[?border(?:$|[-:])/.test(base) && hasBorderUtility(base) && !parts.some(targetsOtherElement)
  );
};

const visibleBorder = (name, value) => /^border\b/i.test(name) && showsBorder(name, value);

const properties = (node) => (node?.type === "ObjectExpression" ? node.properties : []);
const propertyName = (property) => property.key?.name ?? property.key?.value;

const variantTokens = (config) =>
  properties(config).flatMap((property) => {
    if (propertyName(property) === "variants") {
      return properties(property.value).flatMap((variant) =>
        properties(variant.value).flatMap((choice) => extractTokens(choice.value)),
      );
    }

    if (
      propertyName(property) === "compoundVariants" &&
      property.value.type === "ArrayExpression"
    ) {
      return property.value.elements.flatMap((compound) =>
        properties(compound)
          .filter((field) => ["class", "className"].includes(propertyName(field)))
          .flatMap((field) => extractTokens(field.value)),
      );
    }

    return [];
  });

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
              /^\s*@/.test(selector) ||
              splitSelector(selector, /,/).some((item) => lastCompound(item).startsWith("&")),
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
