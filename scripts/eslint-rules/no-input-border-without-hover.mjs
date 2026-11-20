function isHoverToken(token) {
  return (
    token.startsWith("hover:") ||
    token.includes(":hover:") ||
    token.startsWith("group-hover:") ||
    token.includes(":group-hover:") ||
    token.startsWith("peer-hover:") ||
    token.includes(":peer-hover:")
  );
}

function isBorderClass(token) {
  const parts = token.split(":");
  const base = parts[parts.length - 1];

  if (base === "border") {
    return true;
  }

  if (!base.startsWith("border-")) {
    return false;
  }

  if (
    base === "border-0" ||
    base === "border-none" ||
    base === "border-transparent" ||
    base === "border-t-0" ||
    base === "border-b-0" ||
    base === "border-l-0" ||
    base === "border-r-0" ||
    base === "border-s-0" ||
    base === "border-e-0" ||
    base === "border-x-0" ||
    base === "border-y-0" ||
    base === "border-collapse" ||
    base === "border-separate" ||
    base.startsWith("border-spacing")
  ) {
    return false;
  }

  return true;
}

function extractTokens(node) {
  if (!node) {
    return [];
  }

  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value.trim().split(/\s+/).filter(Boolean);
  }

  if (node.type === "JSXExpressionContainer") {
    return extractTokens(node.expression);
  }

  if (node.type === "TemplateLiteral") {
    const tokens = [];

    for (const quasi of node.quasis) {
      if (quasi.value && quasi.value.raw) {
        tokens.push(...quasi.value.raw.trim().split(/\s+/).filter(Boolean));
      }
    }

    for (const expr of node.expressions) {
      tokens.push(...extractTokens(expr));
    }

    return tokens;
  }

  if (node.type === "CallExpression") {
    const tokens = [];

    for (const arg of node.arguments) {
      tokens.push(...extractTokens(arg));
    }

    return tokens;
  }

  if (node.type === "ConditionalExpression") {
    return [...extractTokens(node.consequent), ...extractTokens(node.alternate)];
  }

  if (node.type === "LogicalExpression") {
    return [...extractTokens(node.left), ...extractTokens(node.right)];
  }

  if (node.type === "ArrayExpression") {
    const tokens = [];

    for (const el of node.elements) {
      tokens.push(...extractTokens(el));
    }

    return tokens;
  }

  if (node.type === "ObjectExpression") {
    const tokens = [];

    for (const prop of node.properties) {
      if (prop.type === "Property") {
        if (prop.key.type === "Literal" && typeof prop.key.value === "string") {
          tokens.push(...prop.key.value.trim().split(/\s+/).filter(Boolean));
        } else if (prop.key.type === "Identifier") {
          tokens.push(prop.key.name);
        }
      }
    }

    return tokens;
  }

  return [];
}

function hasBorderInStyle(styleNode) {
  if (!styleNode || styleNode.type !== "ObjectExpression") {
    return false;
  }

  const borderProperties = new Set([
    "border",
    "borderColor",
    "borderWidth",
    "borderStyle",
    "borderTop",
    "borderBottom",
    "borderLeft",
    "borderRight",
    "borderInline",
    "borderBlock",
    "borderTopWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "borderRightWidth",
    "borderTopColor",
    "borderBottomColor",
    "borderLeftColor",
    "borderRightColor",
  ]);

  for (const prop of styleNode.properties) {
    if (prop.type !== "Property") {
      continue;
    }

    const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.value;
    if (borderProperties.has(key)) {
      if (prop.value.type === "Literal") {
        const val = String(prop.value.value).trim().toLowerCase();
        if (
          val !== "none" &&
          val !== "0" &&
          val !== "0px" &&
          val !== "transparent" &&
          val !== "null" &&
          val !== "undefined"
        ) {
          return true;
        }
      } else {
        return true;
      }
    }
  }

  return false;
}

function checkCssFile(context) {
  const text = context.sourceCode.text;
  const lines = text.split("\n");
  const ruleRegex = /([^{}]+)\{([^}]+)\}/g;
  let match;

  const rules = [];

  while ((match = ruleRegex.exec(text)) !== null) {
    rules.push({
      selector: match[1].trim(),
      body: match[2],
      index: match.index,
    });
  }

  for (const rule of rules) {
    const isInput =
      rule.selector.includes("input") ||
      rule.selector.includes("textarea") ||
      rule.selector.includes(".chat-input");

    const isHover = rule.selector.includes(":hover");

    const isFocusOrActive =
      rule.selector.includes(":focus") ||
      rule.selector.includes(":active") ||
      rule.selector.includes(":focus-visible");

    if (isInput && !isHover && !isFocusOrActive) {
      const decls = rule.body
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean);

      for (const decl of decls) {
        if (
          /^(border|border-color|border-top|border-bottom|border-left|border-right)\s*:/i.test(decl)
        ) {
          const val = decl.replace(/^[^:]+:\s*/, "").toLowerCase();

          if (val !== "0" && val !== "0px" && val !== "none" && val !== "transparent") {
            const hasHoverRule = rules.some((r) => {
              if (!r.selector.includes(":hover")) {
                return false;
              }

              const baseSel = rule.selector.replace(/::?[a-z-]+/g, "").trim();
              const hoverSel = r.selector.replace(/::?[a-z-]+/g, "").trim();

              return hoverSel.includes(baseSel) || baseSel.includes(hoverSel);
            });

            if (!hasHoverRule) {
              const index = rule.index;
              let line = 1;
              let charCount = 0;

              for (let i = 0; i < lines.length; i++) {
                if (charCount + lines[i].length >= index) {
                  line = i + 1;
                  break;
                }

                charCount += lines[i].length + 1;
              }

              context.report({
                loc: { start: { line, column: 1 }, end: { line, column: 1 } },
                messageId: "noInputBorderWithoutHover",
              });
            }
          }
        }
      }
    }
  }
}

export const noInputBorderWithoutHover = {
  meta: {
    type: "problem",
    docs: {
      description: "Throw an error if an input box uses border without a hover state",
    },
    schema: [],
    messages: {
      noInputBorderWithoutHover:
        'Input box uses border without a hover state. Add a hover interaction (e.g. "hover:border-...") or remove the border.',
    },
  },
  create(context) {
    const filename = context.filename || "";

    if (filename.endsWith(".css")) {
      return {
        Program() {
          checkCssFile(context);
        },
      };
    }

    return {
      JSXOpeningElement(node) {
        let name = "";

        if (node.name.type === "JSXIdentifier") {
          name = node.name.name;
        } else if (node.name.type === "JSXMemberExpression") {
          name = node.name.property.name;
        }

        const isInputBox =
          name === "input" ||
          name === "textarea" ||
          name === "Input" ||
          name === "Textarea" ||
          name === "TextInput";

        if (!isInputBox) {
          return;
        }

        let hasBorder = false;
        let hasHover = false;
        let isHidden = false;

        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute" || !attr.name) {
            continue;
          }

          const attrName = attr.name.name;

          if (name === "input" && attrName === "type") {
            if (attr.value && attr.value.type === "Literal" && attr.value.value === "hidden") {
              isHidden = true;
            }
          }

          if (attrName === "className" || attrName === "class") {
            const tokens = extractTokens(attr.value);

            for (const token of tokens) {
              if (isHoverToken(token)) {
                hasHover = true;
              } else if (isBorderClass(token)) {
                hasBorder = true;
              }
            }
          }

          if (attrName === "style") {
            if (attr.value && attr.value.type === "JSXExpressionContainer") {
              if (hasBorderInStyle(attr.value.expression)) {
                hasBorder = true;
              }
            }
          }
        }

        if (isHidden) {
          return;
        }

        if (hasBorder && !hasHover) {
          context.report({
            node,
            messageId: "noInputBorderWithoutHover",
          });
        }
      },
    };
  },
};
