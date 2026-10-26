import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, expect, it } from "vitest";

const exec = promisify(execFile);
let root: string;
let repository: string;

// Ordinary Git is intentional: the application's hardened executor suppresses contributor hooks.
const run = (command: string, args: string[], cwd = repository) =>
  exec(command, args, {
    cwd,
    env: { ...process.env, CI: "", HUSKY: "1", XDG_CONFIG_HOME: join(root, "config") },
  });

const git = (...args: string[]) => run("git", args);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vibestar-contributor-hooks-"));
  repository = join(root, "checkout");
  await mkdir(join(repository, "scripts"), { recursive: true });
  await mkdir(join(repository, ".husky"));
  for (const file of [
    "scripts/install-hooks.mjs",
    ".husky/pre-commit",
    ".husky/pre-push",
    ".prettierrc.json",
    "eslint.config.js",
    "lint-staged.config.js",
  ])
    await copyFile(resolve(file), join(repository, file));
  await symlink(resolve("node_modules"), join(repository, "node_modules"), "dir");

  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      scripts: {
        prepush: "npm run check && npm run test:security",
        check: "node check.mjs",
        "test:security": "node security.mjs",
      },
    }),
  );

  for (const name of ["check", "security"])
    await writeFile(
      join(repository, `${name}.mjs`),
      `import { access, writeFile } from "node:fs/promises"; await writeFile(".${name}-ran", "yes"); process.exit(await access(".${name}-fail").then(() => 1, () => 0));\n`,
    );
  await writeFile(join(repository, ".gitignore"), "node_modules/\n.husky/_/\n.*-ran\n.*-fail\n");

  await writeFile(
    join(repository, "example.ts"),
    "export const staged = 1;\n\nexport const retained = 1;\n",
  );

  await git("init", "-b", "main");
  await git("config", "user.name", "Hook fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("add", ".");
  await git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture baseline");
  await run(process.execPath, ["scripts/install-hooks.mjs"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("formats staged content while preserving unstaged hunks and unrelated files", async () => {
  await writeFile(
    join(repository, "example.ts"),
    "export const staged=2;\n\nexport const retained = 1;\n",
  );

  await git("add", "example.ts");

  await writeFile(
    join(repository, "example.ts"),
    "export const staged=2;\n\nexport const retained = 999;\n",
  );

  await writeFile(join(repository, "unrelated.md"), "keep   this\n");
  await git("commit", "-m", "format staged change");

  expect((await git("show", "HEAD:example.ts")).stdout).toBe(
    "export const staged = 2;\n\nexport const retained = 1;\n",
  );

  expect(await readFile(join(repository, "example.ts"), "utf8")).toContain("retained = 999");
  expect(await readFile(join(repository, "unrelated.md"), "utf8")).toBe("keep   this\n");
  expect((await git("status", "--porcelain")).stdout).toContain(" M example.ts");
  expect((await git("status", "--porcelain")).stdout).toContain("?? unrelated.md");
}, 30000);

it.each(["const unused=2;\n", "export const broken=;\n"])(
  "rejects invalid staged code (%s) and restores staged/working content",
  async (source) => {
    const head = (await git("rev-parse", "HEAD")).stdout;
    await writeFile(join(repository, "example.ts"), source);
    await git("add", "example.ts");
    const staged = (await git("diff", "--cached")).stdout;
    await expect(git("commit", "-m", "must fail")).rejects.toThrow();
    expect((await git("rev-parse", "HEAD")).stdout).toBe(head);
    expect((await git("diff", "--cached")).stdout).toBe(staged);
    expect(await readFile(join(repository, "example.ts"), "utf8")).toBe(source);
  },
  30000,
);

it("permits a passing push and rejects either quality or security failures", async () => {
  const remote = join(root, "remote.git");
  await run("git", ["init", "--bare", remote], root);
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");
  expect(await readFile(join(repository, ".check-ran"), "utf8")).toBe("yes");
  expect(await readFile(join(repository, ".security-ran"), "utf8")).toBe("yes");
  const before = (await run("git", ["rev-parse", "main"], remote)).stdout;
  await git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "unpublished");
  for (const name of ["check", "security"]) {
    const marker = join(repository, `.${name}-fail`);
    await writeFile(marker, "fail");
    await expect(git("push", "origin", "main")).rejects.toThrow();
    expect((await run("git", ["rev-parse", "main"], remote)).stdout).toBe(before);
    await rm(marker);
  }
}, 30000);

it("preserves an existing private hook policy during installation", async () => {
  const privateHooks = join(root, "private-hooks");
  await mkdir(privateHooks);
  await writeFile(join(privateHooks, "pre-push"), "#!/bin/sh\nexit 19\n", { mode: 0o700 });
  await git("config", "core.hooksPath", privateHooks);
  const result = await run(process.execPath, ["scripts/install-hooks.mjs"]);
  expect(result.stdout).toContain("preserving the existing core.hooksPath");
  expect((await git("config", "--get", "core.hooksPath")).stdout.trim()).toBe(privateHooks);
  expect(await readFile(join(privateHooks, "pre-push"), "utf8")).toBe("#!/bin/sh\nexit 19\n");
});

it("preserves ordinary private hooks when no hooksPath is configured", async () => {
  await git("config", "--unset", "core.hooksPath");
  const hook = join(repository, ".git", "hooks", "pre-push");
  await writeFile(hook, "#!/bin/sh\nexit 23\n", { mode: 0o700 });
  const result = await run(process.execPath, ["scripts/install-hooks.mjs"]);
  expect(result.stdout).toContain("preserving existing repository hooks");
  await expect(git("config", "--get", "core.hooksPath")).rejects.toMatchObject({ code: 1 });
  expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\nexit 23\n");
});

it("skips linked worktrees without changing their shared hook policy", async () => {
  const linked = join(root, "linked");
  const policy = (await git("config", "--get", "core.hooksPath")).stdout;
  await git("worktree", "add", "-b", "linked", linked);
  await run(process.execPath, ["scripts/install-hooks.mjs"], linked);
  expect((await git("config", "--get", "core.hooksPath")).stdout).toBe(policy);

  await expect(readFile(join(linked, ".husky", "_", "pre-commit"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each([".husky", ".husky/_"])("refuses a linked generated hook directory (%s)", async (path) => {
  const privateHooks = join(root, "private");
  await mkdir(privateHooks);
  await writeFile(join(privateHooks, "pre-push"), "private bytes\n");
  await rm(join(repository, path), { recursive: true, force: true });
  await symlink(privateHooks, join(repository, path), "dir");

  await expect(run(process.execPath, ["scripts/install-hooks.mjs"])).rejects.toThrow(
    "must be a physical directory",
  );

  expect(await readFile(join(privateHooks, "pre-push"), "utf8")).toBe("private bytes\n");
});
