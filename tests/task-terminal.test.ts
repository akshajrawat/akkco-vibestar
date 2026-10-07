import { it, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../backend/execution/engine";
import { TaskTerminals } from "../backend/execution/task-terminals";
import { parseIssue } from "../backend/domain";
import { fixtureRepository, FixtureProvider, waitForTask } from "./fixtures";
it("runs a real task-scoped PTY, retains the session and excludes simultaneous agents in that worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-task-terminal-"));
  const engine = await Engine.create(
    join(dir, "ade"),
    () => new FixtureProvider(),
  );
  const terminals = new TaskTerminals(engine);
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const a = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/12"),
      "Task A",
      "",
      {},
    );
    await waitForTask(
      engine,
      a.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
    const task = engine.db.task(a.id);
    const session = await terminals.open(a.id, 100, 25);
    expect(engine.isActive(a.id)).toBe(true);
    expect(engine.cleanupBlockers(a.id)).toMatchObject([
      { id: `terminal:${a.id}`, kind: "terminal", task_id: a.id },
    ]);
    expect((await terminals.open(a.id, 120, 25)).session_id).toBe(
      session.session_id,
    );
    expect(engine.followUp(a.id, "Save during this terminal")).toMatchObject({
      disposition: "draft",
    });
    expect(engine.db.detail(a.id).messages.at(-1)?.content).toBe(
      "Save during this terminal",
    );
    const b = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/13"),
      "Task B",
      "",
      {},
    );
    await waitForTask(
      engine,
      b.id,
      (s) => s === "ready_for_review" || s === "failed",
    );
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
    expect(await readFile(join(task.worktree_path, "source.txt"), "utf8")).toBe(
      "terminal-A",
    );
    expect(
      await readFile(
        join(engine.db.task(b.id).worktree_path, "source.txt"),
        "utf8",
      ),
    ).toBe("B\n");
    expect(terminals.current(a.id)?.output).toContain("TERM_A_DONE");
    terminals.resize(a.id, session.session_id, 90, 20);
    expect(
      engine.db.all(
        "SELECT id FROM terminal_sessions WHERE task_id=? AND status='running'",
        a.id,
      ),
    ).toHaveLength(1);
    await terminals.close(a.id);
    expect(engine.isActive(a.id)).toBe(false);
    expect(engine.cleanupBlockers(a.id)).toEqual([]);
    expect(terminals.current(a.id)).toBeNull();
    expect(
      engine.db.all("SELECT id FROM terminal_sessions WHERE status='closed'"),
    ).toHaveLength(1);
  } finally {
    await terminals.dispose();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
