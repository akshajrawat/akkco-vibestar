import { access, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { AdeError } from "../domain";
import { cleanEnvironment, execute } from "../execution/process";
import type { Engine } from "../execution/engine";

const editors = [
  { id: "code", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "windsurf", label: "Windsurf" },
  { id: "codium", label: "VSCodium" },
];
export const discoverEditors = async () => {
  const roots = (cleanEnvironment().PATH || "").split(":").filter(Boolean);
  const available = await Promise.all(
    editors.map(async (editor) => {
      for (const root of roots) {
        const executable = join(root, editor.id);
        if (
          await access(executable, constants.X_OK).then(
            () => true,
            () => false,
          )
        ) {
          const windowsExecutable =
            editor.id === "code" &&
            process.env.WSL_DISTRO_NAME &&
            executable.startsWith("/mnt/")
              ? join(dirname(executable), "..", "Code.exe")
              : undefined;
          const windowsLauncher =
            windowsExecutable &&
            (await access(windowsExecutable, constants.X_OK).then(
              () => true,
              () => false,
            ))
              ? windowsExecutable
              : undefined;
          return { ...editor, executable, windowsLauncher };
        }
      }
      return null;
    }),
  );
  return available.filter((e) => e !== null);
};
export class Editors {
  constructor(
    private readonly engine: Engine,
    private readonly repairPath?: (id: string) => Promise<string>,
  ) {}
  list = async () => ({
    editors: await discoverEditors(),
    default: this.engine.db.settings().default_editor,
  });
  open = async (
    id: string,
    kind: "task" | "repository" | "repair",
    editor: string,
  ) => {
    this.engine.assertAvailable();
    const available = await discoverEditors();
    const selected = available.find((e) => e.id === editor);
    if (!selected)
      throw new AdeError(
        "editor_unavailable",
        "This editor CLI is unavailable. Open the folder or copy its path instead.",
      );
    const path =
      kind === "repair" && this.repairPath
        ? await this.repairPath(id)
        : kind === "task"
          ? await this.engine.git.assertTask(this.engine.db.task(id))
          : await realpath(this.engine.db.repository(id).path);
    if (selected.windowsLauncher) {
      // The installed VS Code CLI exposes --folder-uri. Opening its native
      // launcher with a WSL URI keeps Windows/WSL integration in the editor.
      const uri =
        `vscode-remote://wsl+${encodeURIComponent(process.env.WSL_DISTRO_NAME!)}` +
        path.split("/").map(encodeURIComponent).join("/");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(selected.windowsLauncher!, ["--folder-uri", uri], {
          cwd: path,
          env: { ...cleanEnvironment(), WSL_INTEROP: process.env.WSL_INTEROP },
          stdio: "ignore",
          detached: true,
          shell: false,
        });
        child.on("error", (error) =>
          reject(
            new AdeError(
              "editor_failed",
              `Couldn't start VS Code. ${error.message}`,
            ),
          ),
        );
        child.on("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return { path, editor: selected.id };
    }
    const output = await execute({
      program: selected.executable,
      args: [path],
      cwd: path,
      // Official WSL editor shims may install their server on the first launch.
      timeoutMs: 900000,
      wslInterop: true,
    });
    if (output.code !== 0)
      throw new AdeError(
        "editor_failed",
        `Couldn't open ${selected.label}. ${output.stderr.slice(-2000)}`,
      );
    return { path, editor: selected.id };
  };
}
