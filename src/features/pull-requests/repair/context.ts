import type { DiffFile, FileDiff } from "../../../lib/types";
import { rpc } from "../../../lib/api";
import type { ContextOption } from "../../chat/Composer";

export const repairContext = ({
  id,
  files,
  selected,
  scope,
  failures,
  layer,
}: {
  id: string;
  files: DiffFile[];
  selected: string;
  scope?: string;
  failures?: string;
  layer?: "original" | "upstream" | "repair";
}): ContextOption[] => {
  const file = files.find((file) => file.path === selected) || files[0];

  const loadFile = (path: string, old_path?: string | null, fileLayer = layer) =>
    rpc<FileDiff>("repair.file", {
      id,
      path,
      old_path,
      ...(fileLayer ? { layer: fileLayer } : {}),
    });

  return [
    {
      label: "Reference a worktree file",
      input: "Repository-relative file path",
      load: async (path) => {
        const result = await loadFile(path, undefined, "repair");
        if (result.binary) throw new Error("Binary or oversized files cannot be attached as text.");
        return { label: `Worktree file: ${path}`, text: result.modified };
      },
    },
    ...(files.length
      ? [
          {
            label: "Reference changed files",
            load: async () => ({
              label: `Changed files${layer ? ` · ${layer}` : ""}`,
              text: files
                .slice(0, 200)
                .map((file) => `${file.status} ${file.path} +${file.insertions} −${file.deletions}`)
                .join("\n"),
            }),
          },
        ]
      : []),
    ...(file
      ? [
          {
            label: "Include selected file diff",
            load: async () => ({
              label: `Diff: ${file.path}${layer ? ` · ${layer}` : ""}`,
              text: (await loadFile(file.path, file.old_path)).unified,
            }),
          },
        ]
      : []),
    ...(scope
      ? [
          {
            label: "Include repair scope",
            load: async () => ({
              label: "Approved repair scope",
              text: scope,
            }),
          },
        ]
      : []),
    ...(failures
      ? [
          {
            label: "Include incomplete checks",
            load: async () => ({
              label: "Incomplete verification",
              text: failures,
            }),
          },
        ]
      : []),
    {
      label: "Add text note",
      input: "Context note",
      load: async (text) => ({ label: "Text note", text }),
    },
  ];
};
