import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Rpc } from "../../backend/rpc";
import { defaultSettings, now, type Task } from "../../backend/domain";
import { readLogTail } from "../../backend/storage/logs";
import { CommandExecutions } from "../../backend/execution/verification/command-executions";
import { AgentRunner } from "../../backend/execution/agents/agent-runner";
import { createFixtureEngine, fixtureRepository, FixtureProvider } from "../helpers/fixtures";
import type { AgentEvent } from "../../src/lib/types";

const taskRecord = (repoId: string): Task => ({
  id: randomUUID(),
  repo_id: repoId,
  issue_number: 1,
  issue_url: "https://github.com/fixture/fixture/issues/1",
  claimed_scope: "source.txt",
  scope_mode: "partial",
  notes: "",
  issue: { title: "Fixture" },
  branch_name: "",
  base_branch: "main",
  base_commit_sha: "",
  worktree_path: "",
  stage: 1,
  status: "cancelled",
  error: null,
  created_at: now(),
  updated_at: now(),
});

it("reads complete historical redacted logs beyond the tail, searches all lines, and preserves UTF-8 and stream boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "vibestar-log-pages-"));
  const id = randomUUID(),
    run = randomUUID();
  const dir = join(root, "logs", id);
  await mkdir(dir, { recursive: true });
  const text = `early needle\n${"normal 🐈 output\n".repeat(90000)}last stdout\n`;
  try {
    await writeFile(join(dir, `${run}.jsonl`), text);
    await writeFile(join(dir, `${run}.stderr.log`), "only stderr\n");
    const tail = await readLogTail(root, id, run, "stdout");
    expect(tail.truncated).toBe(true);
    expect(tail.text).not.toContain("early needle");
    let page = await readLogTail(root, id, run, "stdout", {});
    let restored = page.text;
    while (page.start) {
      page = await readLogTail(root, id, run, "stdout", { before: page.start });
      restored = page.text + restored;
    }
    expect(restored).toBe(text);
    expect((await readLogTail(root, id, run, "stdout", { search: "EARLY NEEDLE" })).text).toBe(
      "early needle\n",
    );
    expect((await readLogTail(root, id, run, "stderr", {})).text).toBe("only stderr\n");
    const long = `x${"🐈".repeat(150000)}\n`;
    await writeFile(join(dir, `${run}.jsonl`), long);
    page = await readLogTail(root, id, run, "stdout", {});
    restored = page.text;
    while (page.start) {
      page = await readLogTail(root, id, run, "stdout", { before: page.start });
      restored = page.text + restored;
    }
    expect(restored).toBe(long);
    let offset = 0;
    restored = "";
    do {
      page = await readLogTail(root, id, run, "stdout", { after: offset });
      expect(page.end).toBeGreaterThan(offset);
      offset = page.end;
      restored += page.text;
    } while (offset < page.size);
    expect(restored).toBe(long);
    await writeFile(join(dir, `${run}.jsonl`), "needle\n".repeat(450));
    const first = await readLogTail(root, id, run, "stdout", {
      search: "needle",
    });
    expect(first.text.split("\n")).toHaveLength(201);
    expect(first.truncated).toBe(true);
    const second = await readLogTail(root, id, run, "stdout", {
      search: "needle",
      after: first.end,
    });
    const third = await readLogTail(root, id, run, "stdout", {
      search: "needle",
      after: second.end,
    });
    expect(first.text + second.text + third.text).toBe("needle\n".repeat(450));
    const largeMatches = `${"needle".repeat(2000)}\n`.repeat(60);
    await writeFile(join(dir, `${run}.jsonl`), largeMatches);
    const bounded = await readLogTail(root, id, run, "stdout", {
      search: "needle",
    });
    expect(Buffer.byteLength(bounded.text)).toBeLessThan(280000);
    expect(bounded.truncated).toBe(true);
    const next = await readLogTail(root, id, run, "stdout", {
      search: "needle",
      after: bounded.end,
    });
    expect(next.end).toBeGreaterThan(bounded.end);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("pages and searches saved run events beyond 2000 and retains full tool context without crossing task ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-event-pages-"));
  const engine = await createFixtureEngine(join(dir, "data"));
  const rpc = new Rpc(engine);
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = taskRecord(repo.id),
      other = taskRecord(repo.id);
    engine.db.saveTask(task);
    engine.db.saveTask(other);
    const run = randomUUID();
    engine.db.run(
      "INSERT INTO agent_runs(id,task_id,stage,provider,model,effort,prompt,status,started_at) VALUES(?,?,3,'codex','actual-model','high','saved prompt','completed',?)",
      run,
      task.id,
      now(),
    );
    const insert = (kind: string, data: unknown) =>
      engine.db.run(
        "INSERT INTO agent_events(run_id,task_id,timestamp,kind,data,raw,stream) VALUES(?,?,?,?,?,?,'stdout')",
        run,
        task.id,
        now(),
        kind,
        JSON.stringify(data),
        JSON.stringify(data),
      );
    insert("command.started", {
      call_id: "tool",
      command: "npm test -- original-needle",
      arguments: { cwd: "src" },
      status: "running",
    });
    for (let i = 0; i < 2100; i++) insert("message", { text: `event ${i}` });
    insert("command.finished", {
      call_id: "tool",
      status: "completed",
      exit_code: 0,
    });
    expect(engine.db.detail(task.id).events).toHaveLength(2000);
    const search = (await rpc.call("task.events", {
      id: task.id,
      run_id: run,
      search: "original-needle",
    })) as { events: AgentEvent[]; context: AgentEvent[]; more: boolean };
    expect(search.events).toHaveLength(1);
    expect(search.context.at(-1)?.kind).toBe("command.finished");
    let count = 0,
      before: number | undefined;
    let more = true;
    while (more) {
      const page = (await rpc.call("task.events", {
        id: task.id,
        run_id: run,
        before,
      })) as typeof search;
      count += page.events.length;
      before = page.events[0].id;
      more = page.more;
    }
    expect(count).toBe(2102);
    await expect(rpc.call("task.events", { id: other.id, run_id: run })).rejects.toMatchObject({
      kind: "isolation",
    });
    await expect(
      rpc.call("task.logs", {
        id: other.id,
        run_id: run,
        stream: "stdout",
        paged: true,
      }),
    ).rejects.toMatchObject({ kind: "isolation" });
    const commands = new CommandExecutions(engine.db);
    commands.observe(task.id, run, {
      kind: "command.finished",
      data: {
        call_id: "interrupted",
        command: "npm test",
        status: "interrupted",
        exit_code: 0,
      },
    });
    expect(engine.db.detail(task.id).tests[0].status).toBe("interrupted");
  } finally {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("persists actual emitted model/effort and separate redacted streams without trusting structured stderr as a result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-output-runner-"));
  const fixture = new FixtureProvider();
  const engine = await createFixtureEngine(join(dir, "data"));
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = taskRecord(repo.id);
    engine.db.saveTask(task);
    await engine.git.prepare(repo, task);
    engine.db.saveTask(task);
    const runner = new AgentRunner(
      engine.root,
      engine.db,
      engine.git,
      (e) => engine.publish(e),
      () => ({
        ...fixture,
        invocation: (request) => {
          const invocation = fixture.invocation(request);
          return {
            ...invocation,
            args: [
              "-e",
              `console.log(JSON.stringify({event:'init',init:{model:'reported-model',effort:'high'}}));${invocation.args[1]}console.error(JSON.stringify({type:'item.completed',model:'wrong-stderr-model',item:{type:'agent_message',text:'{}'}}));console.error('access_token=private-secret');`,
            ],
          };
        },
      }),
    );
    await runner.run(
      task,
      {
        ...defaultSettings,
        antigravity: { model: "next-model", effort: "low", timeout_secs: 30 },
      },
      new AbortController().signal,
    );
    const detail = engine.db.detail(task.id);
    const run = detail.runs[0];
    expect(run).toMatchObject({
      model: "reported-model",
      effort: "high",
      status: "completed",
    });
    expect(detail.usage[0]).toMatchObject({
      model: "reported-model",
      effort: "high",
    });
    expect(detail.events.some((e) => e.stream === "stderr")).toBe(true);
    const stdout = await readFile(join(engine.root, "logs", task.id, `${run.id}.jsonl`), "utf8");
    const stderr = await readFile(
      join(engine.root, "logs", task.id, `${run.id}.stderr.log`),
      "utf8",
    );
    expect(stdout).not.toContain("wrong-stderr-model");
    expect(stderr).toContain("wrong-stderr-model");
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain("private-secret");
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});
