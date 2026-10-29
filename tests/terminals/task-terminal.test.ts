import { it, expect } from "vitest";

import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskTerminals } from "../../backend/execution/terminals/task-terminals";
import { checked } from "../../backend/execution/runtime/process";
import { parseIssue } from "../../backend/domain";
import {
  createFixtureEngine,
  fixtureRepository,
  FixtureProvider,
  finishFixtureTask as waitForTask,
  prepareFixtureTask,
} from "../helpers/fixtures";

it("runs a real task-scoped PTY, retains the session and excludes simultaneous agents in that worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-task-terminal-"));
  const engine = await createFixtureEngine(join(dir, "ade"), () => new FixtureProvider());

  const terminals = new TaskTerminals(engine, undefined, {
    PATH: process.env.PATH,
    HOME: dir,
    SHELL: "/bin/bash",
  });

  try {
    const { repo } = await fixtureRepository(engine, dir);

    const a = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/12"),
      "Task A",
      "",
      {},
    );

    await waitForTask(engine, a.id, (s) => s === "ready_for_review" || s === "failed");
    const task = engine.db.task(a.id);

    const [session, duplicate] = await Promise.all([
      terminals.open(a.id, 100, 25),
      terminals.open(a.id, 100, 25),
    ]);

    expect(duplicate.session_id).toBe(session.session_id);

    expect(session).toMatchObject({
      cwd: task.worktree_path,
      shell: "bash",
      branch: task.branch_name,
    });

    expect(await checked("git", ["remote", "get-url", "origin"], task.worktree_path)).toBe(
      repo.upstream_url,
    );

    expect(engine.isActive(a.id)).toBe(true);

    expect(engine.cleanupBlockers(a.id)).toMatchObject([
      { id: `terminal:${a.id}`, kind: "terminal", task_id: a.id },
    ]);

    expect((await terminals.open(a.id, 120, 25)).session_id).toBe(session.session_id);

    expect(engine.followUp(a.id, "Save during this terminal")).toMatchObject({
      disposition: "draft",
    });

    expect(engine.db.detail(a.id).messages.at(-1)?.content).toBe("Save during this terminal");

    const b = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/13"),
      "Task B",
      "",
      {},
    );

    await waitForTask(engine, b.id, (s) => s === "ready_for_review" || s === "failed");
    expect(engine.db.task(b.id).status).toBe("ready_for_review");

    const done = new Promise<void>((resolve, reject) => {
      let output = "";

      const timer = setTimeout(() => {
        engine.off("event", check);
        reject(Error("Task PTY output deadline"));
      }, 10000);

      const check = (e: { event: string; task_id?: string; text?: string }) => {
        if (e.event === "terminal.output" && e.task_id === a.id) {
          output += e.text;
          if (output.includes("TERM_A_DONE")) {
            clearTimeout(timer);
            engine.off("event", check);
            resolve();
          }
        }
      };

      engine.on("event", check);
    });

    terminals.input(
      a.id,
      session.session_id,
      "printf terminal-A > source.txt; printf 'TERM_'; printf 'A_DONE\\n'\r",
    );

    await done;
    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe("terminal-A");

    expect(await readFile(join(engine.db.task(b.id).worktree_path, "source.txt"), "utf8")).toBe(
      "B\n",
    );

    expect(terminals.current(a.id)?.output).toContain("TERM_A_DONE");
    terminals.resize(a.id, session.session_id, 90, 20);

    expect(
      engine.db.all("SELECT id FROM terminal_sessions WHERE task_id=? AND status='running'", a.id),
    ).toHaveLength(1);

    await terminals.close(a.id);
    expect(engine.isActive(a.id)).toBe(false);
    expect(engine.cleanupBlockers(a.id)).toEqual([]);
    expect(terminals.current(a.id)).toBeNull();
    expect(engine.db.all("SELECT id FROM terminal_sessions WHERE status='closed'")).toHaveLength(1);
  } finally {
    await terminals.dispose();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("saves and replays only sanitized split-token output with continuous emitted sequence numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-terminal-redaction-"));
  const engine = await createFixtureEngine(join(dir, "data"));

  const terminals = new TaskTerminals(engine, undefined, {
    PATH: process.env.PATH,
    HOME: dir,
    SHELL: "/bin/bash",
  });

  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "redacted-terminal");
    const session = await terminals.open(task.id, 100, 25);
    const chunks: { text: string; sequence: number }[] = [];

    const done = new Promise<void>((resolve) => {
      engine.on("event", (event) => {
        if (event.event !== "terminal.output" || event.task_id !== task.id) return;

        chunks.push({
          text: event.text!,
          sequence: (event.data as { sequence: number }).sequence,
        });

        if (
          chunks
            .map((chunk) => chunk.text)
            .join("")
            .includes("TERM_SECRET_CHECK")
        )
          resolve();
      });
    });

    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz123456_ABCDEFG";
    const encoded = Buffer.from(secret).toString("base64");
    const script = `const v=Buffer.from("${encoded}","base64").toString();process.stdout.write(v.slice(0,7));setTimeout(()=>{process.stdout.write(v.slice(7)+"\\n");console.log(["TERM","SECRET","CHECK"].join("_"));},30);`;
    terminals.input(task.id, session.session_id, `node -e '${script}'\r`);
    await done;
    const snapshot = terminals.current(task.id)!;
    expect(snapshot.output).toContain("[REDACTED]");
    expect(snapshot.output).not.toContain(secret);
    expect(snapshot.output).not.toContain("hijklmnopqrstuvwxyz123456");
    for (let index = 1; index < chunks.length; index++)
      expect(chunks[index].sequence).toBe(chunks[index - 1].sequence + 1);
    await terminals.close(task.id);

    const log = await readFile(
      join(engine.root, "logs", task.id, `${session.session_id}.terminal.log`),
      "utf8",
    );

    expect(log).toContain("[REDACTED]");
    expect(log).not.toContain(secret);
    expect(log).not.toContain("hijklmnopqrstuvwxyz123456");
  } finally {
    await terminals.dispose();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15000);

it("commits with user Git configuration and pushes to a local remote from the manual terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-manual-git-"));
  const engine = await createFixtureEngine(join(dir, "data"));

  const terminals = new TaskTerminals(engine, undefined, {
    PATH: process.env.PATH,
    HOME: dir,
    SHELL: "/bin/bash",
  });

  try {
    await writeFile(
      join(dir, ".gitconfig"),
      "[user]\n  name = Terminal User\n  email = terminal@example.invalid\n",
    );

    const { repo } = await fixtureRepository(engine, dir);
    const task = await prepareFixtureTask(engine, repo, "manual-git");
    const remote = join(dir, "remote.git");
    await checked("git", ["init", "--bare", remote], dir);
    repo.origin_url = remote;
    engine.db.saveRepository(repo);
    const sourceHead = await checked("git", ["rev-parse", "HEAD"], repo.path);
    await writeFile(join(task.worktree_path, "manual.txt"), "Manual contribution\n");
    const session = await terminals.open(task.id, 160, 25);

    const done = new Promise<void>((resolve, reject) => {
      let output = "";

      const timer = setTimeout(() => {
        engine.off("event", read);
        reject(new Error("Manual Git PTY deadline: " + output));
      }, 10000);

      const read = (event: { event: string; task_id?: string; text?: string }) => {
        if (event.event !== "terminal.output" || event.task_id !== task.id) return;
        output += event.text || "";
        if (output.includes("MANUAL_GIT_COMPLETE")) {
          clearTimeout(timer);
          engine.off("event", read);
          resolve();
        }
      };

      engine.on("event", read);
    });

    terminals.input(
      task.id,
      session.session_id,
      "git add manual.txt && git commit -m 'Manual terminal commit' && git push origin HEAD:refs/heads/contribution && printf 'MANUAL_'; printf 'GIT_COMPLETE\\n'\r",
    );

    await done;
    const head = await checked("git", ["rev-parse", "HEAD"], task.worktree_path);
    expect(head).not.toBe(sourceHead);
    expect(await checked("git", ["rev-parse", "refs/heads/contribution"], remote)).toBe(head);

    expect(
      await checked("git", ["show", "-s", "--format=%an <%ae>", "HEAD"], task.worktree_path),
    ).toBe("Terminal User <terminal@example.invalid>");

    expect(await checked("git", ["rev-parse", "HEAD"], repo.path)).toBe(sourceHead);
    expect(engine.db.all("SELECT id FROM agent_runs")).toEqual([]);
    await terminals.close(task.id);
  } finally {
    await terminals.dispose();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it.each(["imported", "managed-with-origin"])(
  "preserves existing Git configuration for %s checkouts",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-terminal-origin-"));
    const engine = await createFixtureEngine(join(dir, "data"));

    const terminals = new TaskTerminals(engine, undefined, {
      PATH: process.env.PATH,
      HOME: dir,
      SHELL: "/bin/bash",
    });

    try {
      const { repo } = await fixtureRepository(engine, dir);
      const task = await prepareFixtureTask(engine, repo, "origin-preservation");
      if (mode === "imported") {
        repo.source = "imported";
        engine.db.saveRepository(repo);
      } else {
        await checked(
          "git",
          ["remote", "add", "origin", join(dir, "custom-destination.git")],
          repo.path,
        );
      }

      const before = await readFile(join(repo.path, ".git", "config"), "utf8");
      await terminals.open(task.id, 100, 25);
      expect(await readFile(join(repo.path, ".git", "config"), "utf8")).toBe(before);
      await terminals.close(task.id);
    } finally {
      await terminals.dispose();
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
