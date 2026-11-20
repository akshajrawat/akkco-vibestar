import fs from "node:fs";
import path from "node:path";

export const noPnpm = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      noPnpmFile: 'pnpm is forbidden. Found "{{file}}". Delete it and use npm instead.',
    },
  },
  create(context) {
    let reportedRoot = false;

    return {
      Program(node) {
        if (!reportedRoot) {
          reportedRoot = true;
          const root = context.cwd || process.cwd();

          for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
            if (fs.existsSync(path.join(root, file))) {
              context.report({
                node,
                messageId: "noPnpmFile",
                data: { file },
              });
            }
          }
        }
      },
    };
  },
};
