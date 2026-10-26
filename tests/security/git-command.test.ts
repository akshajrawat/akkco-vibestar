import { securityWorkspace } from "./fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checked, execute, type ProcessRequest } from "../../backend/execution/runtime/process";
import { gitCapture, gitChecked, gitExecute } from "../../backend/workspace/git-command";
import { exists } from "../../backend/workspace/paths";
import * as processes from "../../backend/execution/runtime/process";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("suppresses fsmonitor on actual workspace reads and leaves source files, index and configuration intact", async () => {
  const { source, task, marker, program, git } = await securityWorkspace();
  await checked("git", ["config", "core.fsmonitor", program], source);
  // The disposable trigger is executable under ordinary Git, independently of Vibestar.
  await checked("git", ["status", "--porcelain"], source);
  expect(await exists(marker)).toBe(true);
  await rm(marker);
  const index = await readFile(join(source, ".git", "index"));
  const config = await readFile(join(source, ".git", "config"));
  await writeFile(join(task.worktree_path, "file.txt"), "changed\n");
  expect((await git.diff(task)).files.some((file) => file.path === "file.txt")).toBe(true);
  expect(await exists(marker)).toBe(false);
  expect(await readFile(join(source, ".git", "index"))).toEqual(index);
  expect(await readFile(join(source, ".git", "config"))).toEqual(config);
  expect(await readFile(join(source, "file.txt"), "utf8")).toBe("base\n");
});

it.each([
  "filter.hostile.clean",
  "filter.hostile.smudge",
  "filter.hostile.process",
  "merge.hostile.driver",
  "diff.hostile.command",
  "diff.hostile.textconv",
  "gpg.program",
  "branch.fixture-task.mergeOptions",
  "core.gitProxy",
  "include.path",
  "includeIf.gitdir:/.path",
  "url.https://unexpected.invalid/.insteadOf",
  "url.https://unexpected.invalid/.pushInsteadOf",
  "credential.https://unexpected.invalid.helper",
  "remote.upstream.uploadpack",
])(
  "refuses unsupported %s before mutation without executing or disclosing its value",
  async (key) => {
    const { source, task, program, marker } = await securityWorkspace();
    const value = `${program} api_key=fixture-private-value`;
    await checked("git", ["config", key, value], source);
    const before = await readFile(join(source, ".git", "config"));

    const metadata = (await readFile(join(task.worktree_path, ".git"), "utf8"))
      .slice("gitdir: ".length)
      .trim();

    const index = await readFile(join(metadata, "index"));

    const operation = gitExecute({
      program: "git",
      args: ["add", "."],
      cwd: task.worktree_path,
    });

    await expect(operation).rejects.toThrow(
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    );

    await expect(operation).rejects.not.toThrow("fixture-private-value");
    expect(await exists(marker)).toBe(false);
    expect(await readFile(join(source, ".git", "config"))).toEqual(before);
    expect(await readFile(join(metadata, "index"))).toEqual(index);
  },
);

it("blocks a configured merge driver before a conflicting merge can modify the worktree or index", async () => {
  const { source, task, program, marker } = await securityWorkspace();
  for (const [cwd, value] of [
    [source, "incoming\n"],
    [task.worktree_path, "local\n"],
  ]) {
    await writeFile(join(cwd, ".gitattributes"), "file.txt merge=hostile\n");
    await writeFile(join(cwd, "file.txt"), value);
    await checked("git", ["add", "."], cwd);
    await checked("git", ["commit", "-m", value.trim()], cwd);
  }

  const head = await gitChecked(["rev-parse", "HEAD"], task.worktree_path);

  const metadata = (await readFile(join(task.worktree_path, ".git"), "utf8"))
    .slice("gitdir: ".length)
    .trim();

  const index = await readFile(join(metadata, "index"));
  await checked("git", ["config", "merge.hostile.driver", program], source);

  await expect(
    gitExecute({
      program: "git",
      args: ["merge", "--no-edit", "main"],
      cwd: task.worktree_path,
    }),
  ).rejects.toThrow("merge.hostile.driver");

  expect(await exists(marker)).toBe(false);
  expect(await readFile(join(task.worktree_path, "file.txt"), "utf8")).toBe("local\n");
  await checked("git", ["config", "--unset", "merge.hostile.driver"], source);
  expect(await gitChecked(["rev-parse", "HEAD"], task.worktree_path)).toBe(head);
  expect(await readFile(join(metadata, "index"))).toEqual(index);
});

it("suppresses hooks and signing while making an ordinary local commit", async () => {
  const { source, task, program, marker } = await securityWorkspace();
  const hooks = join(source, ".git", "hooks");

  await writeFile(join(hooks, "pre-commit"), await readFile(program), {
    mode: 0o700,
  });

  await checked("git", ["config", "commit.gpgSign", "true"], source);
  await writeFile(join(task.worktree_path, "file.txt"), "reviewed\n");
  await gitChecked(["add", "."], task.worktree_path);
  await gitChecked(["commit", "-m", "reviewed local commit"], task.worktree_path);
  expect(await exists(marker)).toBe(false);
  expect(await gitChecked(["show", "HEAD:file.txt"], task.worktree_path)).toBe("reviewed");

  await expect(gitCapture(["-c", `core.hooksPath=${hooks}`, "status"], source)).rejects.toThrow(
    "core.hookspath",
  );
});

it("ignores hostile global/system includes and inherited Git overrides without altering them", async () => {
  const { dir, source, marker, program } = await securityWorkspace();
  const home = join(dir, "home");
  await mkdir(home);
  const config = `[core]\nfsmonitor = ${program}\n[include]\npath = ${join(dir, "not-read")}\n`;
  await writeFile(join(home, ".gitconfig"), config);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_SYSTEM", join(home, ".gitconfig"));
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
  vi.stubEnv("GIT_CONFIG_VALUE_0", program);
  expect((await gitCapture(["status", "--porcelain"], source)).code).toBe(0);
  expect(await exists(marker)).toBe(false);
  expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe(config);
});

it.each(["true", "2", "-1"])(
  "checks per-worktree configuration enabled with %s before executing the selected command",
  async (enabled) => {
    const { source, task, program, marker } = await securityWorkspace();
    await checked("git", ["config", "extensions.worktreeConfig", enabled], source);

    await checked(
      "git",
      ["config", "--worktree", "filter.hostile.process", program],
      task.worktree_path,
    );

    await expect(gitCapture(["status", "--porcelain"], task.worktree_path)).rejects.toThrow(
      "filter.hostile.process",
    );

    expect(await exists(marker)).toBe(false);
  },
);

it("binds HTTPS transport, gh authentication and redirect policy without contacting GitHub", async () => {
  const { source } = await securityWorkspace();
  let invocation: ProcessRequest | undefined;

  await gitExecute(
    {
      program: "git",
      args: ["ls-remote", "--refs", "--", "git@github.com:oppia/oppia.git", "refs/heads/develop"],
      cwd: source,
    },
    async (request) => {
      invocation = request;
      return { code: 0, stdout: "", stderr: "", duration_ms: 0 };
    },
  );

  expect(invocation?.args).toContain("https://github.com/oppia/oppia.git");
  expect(invocation?.args).toContain("credential.helper=");

  expect(invocation?.args).toContain(
    "credential.https://github.com.helper=!gh auth git-credential",
  );

  expect(invocation?.args).toContain("http.followRedirects=false");
  expect(invocation?.gitEnvironment).toBe(true);
  for (const destination of [
    "ext::sh -c hostile",
    "https://unexpected.invalid/repo",
    source,
    "file:///tmp/fixture",
    "https://github.com/oppia/oppia.git?redirect=1",
  ]) {
    await expect(
      gitExecute({
        program: "git",
        args: ["ls-remote", "--", destination],
        cwd: source,
      }),
    ).rejects.toThrow();
  }

  expect(
    (
      await gitExecute({
        program: "git",
        args: ["ls-remote", "--", source],
        cwd: source,
        allowLocalTransport: true,
      })
    ).code,
  ).toBe(0);
});

it("rejects partial clones on Git versions that cannot disable implicit transport", async () => {
  const { source } = await securityWorkspace();
  await checked("git", ["config", "remote.upstream.promisor", "true"], source);
  const original = processes.execute;

  vi.spyOn(processes, "execute").mockImplementation((request) =>
    request.args[0] === "--version"
      ? Promise.resolve({
          code: 0,
          stdout: "git version 2.43.0\n",
          stderr: "",
          duration_ms: 0,
        })
      : original(request),
  );

  await expect(gitCapture(["show", "HEAD:file.txt"], source)).rejects.toThrow("Git 2.45 or newer");
});

it("fails integrity capture explicitly on overflow and keeps streamed output redacted", async () => {
  const { source } = await securityWorkspace();
  const lines: string[] = [];

  await expect(
    execute({
      program: process.execPath,
      args: [
        "-e",
        "for(let i=0;i<34;i++)process.stdout.write(('api_key=fixture-secret '+ 'x'.repeat(1024)+'\\n').repeat(1024))",
      ],
      cwd: source,
      rawStdoutForIntegrity: true,
      onLine: (_, line) => lines.push(line),
    }),
  ).rejects.toThrow("capture limit");

  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((line) => line.includes("fixture-secret"))).toBe(false);
});

it("captures NUL-delimited integrity evidence beyond the display line budget", async () => {
  const { source } = await securityWorkspace();

  const output = await execute({
    program: process.execPath,
    args: ["-e", "process.stdout.write(('100644 '+ 'a'.repeat(40)+' 0\\tpath\\0').repeat(50000))"],
    cwd: source,
    rawStdoutForIntegrity: true,
  });

  expect(output.code).toBe(0);
  expect(Buffer.byteLength(output.stdout)).toBeGreaterThan(2 * 1024 * 1024);
  expect(output.stdout.split("\0")).toHaveLength(50001);
});
