const stateSelector = /:(?:active|focus(?:-visible|-within)?)(?![\w-])/;
const stateVariant = /^(?:(?:group|peer)-)?(?:active|focus(?:-visible|-within)?)(?:\/|$)/;
const inputSelector = /\b(?:input|textarea)\b|\.(?:select-search|library-search)\b/;

const borderProperty =
  /^(?:border(?:-(?!(?:collapse|spacing|image)\b)[a-z-]+)?|outline(?:-(?:color|style|width))?)$/i;

export const showsBorder = (property, value) =>
  borderProperty.test(property) &&
  !property.endsWith("radius") &&
  !/^(?:0(?:px|em|rem|%)?|none|hidden|transparent)(?:\s*!important)?$/i.test(value.trim());

const hasState = (selector) => stateSelector.test(selector.replace(/:not\([^()]*\)/g, ""));

export const splitVariants = (token) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index++) {
    if (token[index] === "[") {
      depth++;
    } else if (token[index] === "]") {
      depth--;
    } else if (token[index] === ":" && depth === 0) {
      parts.push(token.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(token.slice(start));
  return parts;
};

export const hasBorderUtility = (utility) => {
  const base = utility.replace(/^!|!$/g, "");
  if (base.startsWith("[")) {
    const declaration = base.match(/^\[([a-z-]+):(.+)\]$/);
    return !!declaration && showsBorder(declaration[1], declaration[2].replaceAll("_", " "));
  }

  const match = base.match(/^(border|outline)(?:-(.+))?$/);
  return (
    !!match &&
    !/^(?:(?:[tblrsexy]+-|inline(?:-start|-end)?-|block(?:-start|-end)?-)?(?:0|none|hidden|transparent|\[(?:0(?:px)?|none|transparent)\])|collapse|separate|spacing.*|offset-.*)$/.test(
      match[2] || "",
    )
  );
};

const stateBorder = (token, inState = false, targetsInput = true) => {
  const parts = splitVariants(token);
  const utility = parts.pop();
  return (
    hasBorderUtility(utility) &&
    (targetsInput || parts.some((part) => inputSelector.test(part.replaceAll("_", " ")))) &&
    (inState || parts.some((part) => stateVariant.test(part) || hasState(part)))
  );
};

export function extractTokens(node) {
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

export function checkCssBorders(
  context,
  { target, utility, declaration: invalidDeclaration, messageId },
) {
  const { sourceCode } = context;

  const source = sourceCode.text.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\r\n]/g, " "),
  );

  const rules = [];

  const checkDeclarations = (body, rule) => {
    if (!rule?.target) {
      return;
    }

    for (const statement of body.split(";").map((value) => value.trim())) {
      const declaration = statement.match(/^([a-z-]+)\s*:\s*(.+)$/is);

      const offenders = /^@apply\s/.test(statement)
        ? statement
            .slice(7)
            .trim()
            .split(/\s+/)
            .filter((token) => utility(token, rule.inState))
        : declaration && invalidDeclaration(declaration[1], declaration[2], rule.inState)
          ? [statement]
          : [];

      for (const token of offenders) {
        context.report({ loc: rule.loc, messageId, data: { token } });
      }
    }
  };

  let start = 0;
  for (const brace of source.matchAll(/[{}]/g)) {
    const text = source.slice(start, brace.index);
    const parent = rules.at(-1);
    if (brace[0] === "}") {
      checkDeclarations(text, rules.pop());
    } else {
      const selectorStart = text.lastIndexOf(";") + 1;
      const selector = text.slice(selectorStart);
      checkDeclarations(text.slice(0, selectorStart), parent);

      rules.push({
        target: parent?.target || target.test(selector),
        inState: parent?.inState || hasState(selector),
        loc: sourceCode.getLocFromIndex(start + selectorStart + Math.max(0, selector.search(/\S/))),
      });
    }

    start = brace.index + 1;
  }
}

export const noInputBorderOnClick = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow input borders and outlines in active and focused states",
    },
    schema: [],
    messages: {
      noInputBorderOnClick:
        'Input border or outline is visible in an active or focused state (found "{{token}}").',
    },
  },
  create(context) {
    const filename = context.filename || "";

    if (filename.endsWith(".css")) {
      return {
        Program() {
          checkCssBorders(context, {
            target: inputSelector,
            utility: stateBorder,
            declaration: (property, value, inState) => inState && showsBorder(property, value),
            messageId: "noInputBorderOnClick",
          });
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

        let isHidden = false;

        for (const attr of node.attributes) {
          if (attr.type === "JSXAttribute" && attr.name && attr.name.name === "type") {
            if (attr.value && attr.value.type === "Literal" && attr.value.value === "hidden") {
              isHidden = true;
            }
          }
        }

        if (isHidden) {
          return;
        }

        for (const attr of node.attributes) {
          if (attr.type !== "JSXAttribute" || !attr.name) {
            continue;
          }

          const attrName = attr.name.name;

          if (attrName === "className" || attrName === "class") {
            const tokens = extractTokens(attr.value);

            for (const token of tokens) {
              if (stateBorder(token, false, isInputBox)) {
                context.report({
                  node,
                  messageId: "noInputBorderOnClick",
                  data: { token },
                });
              }
            }
          }
        }
      },
    };
  },
};
