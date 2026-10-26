import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Installs contributor hooks only in a primary checkout without an existing hook policy. */
const install = async () => {
  if (process.env.CI || process.env.HUSKY === "0" || process.env.NODE_ENV === "production") return;
  const git = await lstat(".git").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!git?.isDirectory()) return;
  const { stdout: configured } = await exec("git", ["config", "--get", "core.hooksPath"]).catch(
    (error) => {
      if (error.code === 1) return { stdout: "" };
      throw error;
    },
  );
  if (configured.trim() && resolve(configured.trim()) !== resolve(".husky/_")) {
    console.log("Contributor hooks not installed: preserving the existing core.hooksPath.");
    return;
  }
  const hooks = await readdir(".git/hooks").catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!configured.trim() && hooks.some((name) => !name.endsWith(".sample"))) {
    console.log("Contributor hooks not installed: preserving existing repository hooks.");
    return;
  }
  for (const path of [".husky", ".husky/_"]) {
    const entry = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
      throw new Error(`Contributor hooks not installed: ${path} must be a physical directory.`);
  }
  const husky = (await import("husky")).default;
  const result = husky();
  if (result) throw new Error(result);
};

await install();
