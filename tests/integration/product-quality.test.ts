import { it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, parseIssue, now } from "../../backend/domain";
import {
  createFixtureEngine,
  FixtureProvider,
  fixtureRepository,
  finishFixtureTask as waitForTask,
} from "../helpers/fixtures";
import { ReviewService } from "../../backend/review/service";
import { Usage } from "../../backend/execution/output/usage";
import { Database } from "../../backend/storage/database";
import { limitDeltas } from "../../src/lib/usage";
import { Editors, discoverEditors } from "../../backend/workspace/editors";
import { Rpc } from "../../backend/rpc";
import { CoreBridge } from "../../electron/bridge";
import { execute } from "../../backend/execution/runtime/process";
import { discoverCodexModels } from "../../backend/execution/providers/codex-models";
vi.mock("../../backend/execution/providers/codex-models", () => ({
  discoverCodexModels: vi.fn(async () => ({
    models: [],
    subscriptionLimits: {
      reportedAt: now(),
      planType: "plus",
      windows: [{ usedPercent: 37, windowDurationMins: 300, resetsAt: 2000000000 }],
    },
  })),
}));

it("records successful, failed and cancelled provider invocations without starting allowance discovery after cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-usage-lifecycle-"));
  let mode = "success";
  let providerName = "antigravity";
  const fixture = new FixtureProvider();
  const engine = await createFixtureEngine(join(dir, "data"), () => ({
    ...fixture,
    name: providerName,
    detect: async () => ({
      ...(await fixture.detect()),
      provider: providerName,
      subscriptionLimits:
        providerName === "codex"
          ? {
              reportedAt: now(),
              planType: "plus",
              windows: [
                {
                  usedPercent: 31,
                  windowDurationMins: 300,
                  resetsAt: 2000000000,
                },
              ],
            }
          : undefined,
    }),
    invocation: () => ({
      program: process.execPath,
      args: [
        "-e",
        mode === "fail"
          ? "console.error('test failure');process.exit(9)"
          : mode === "cancel"
            ? "console.log(JSON.stringify({type:'thread.started',thread_id:'cancelled-session'}));setInterval(()=>{},1000)"
            : "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'done'})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:21,output_tokens:4}}))",
      ],
    }),
  }));
  try {
    engine.db.saveSettings({
      ...defaultSettings,
      utility_ai: {
        provider: "antigravity",
        model: "next-model",
        effort: "high",
        timeout_secs: 30,
      },
    });
    for (const provider of ["antigravity", "codex"]) {
      providerName = provider;
      for (const status of ["success", "fail", "cancel"]) {
        mode = status;
        const call = engine.utility.run({
          purpose: status === "success" ? "PR Review Analysis" : "Utility AI",
          prompt: "Read-only classification",
        });
        // Attach rejection handling before cancellation, retaining the result.
        const settled = call.then(
          (value) => ({ value, error: null }),
          (error: Error) => ({ value: null, error }),
        );
        if (status === "cancel") {
          await vi.waitFor(() =>
            expect(
              engine.db.all(
                "SELECT provider_session_id FROM ai_usage WHERE provider_session_id='cancelled-session' AND status='running' AND provider=?",
                provider,
              ).length,
            ).toBeGreaterThan(0),
          );
          const blockers = engine.cleanupBlockers().filter((b) => b.kind === "task");
          await engine.stopActivity(blockers[0].id);
        }
        const result = await settled;
        expect(!!result.error).toBe(status !== "success");
      }
    }
    const rows = new Usage(engine.db).list();
    expect(rows).toHaveLength(6);
    for (const provider of ["antigravity", "codex"])
      expect(
        rows
          .filter((r) => r.provider === provider)
          .map((r) => r.status)
          .sort(),
      ).toEqual(["cancelled", "completed", "failed"]);
    expect(rows.every((r) => r.duration_ms !== null && r.ended_at)).toBe(true);
    expect(
      rows
        .filter((r) => r.status === "completed")
        .every((r) => r.input_tokens === 21 && r.output_tokens === 4 && r.total_tokens === null),
    ).toBe(true);
    expect(
      rows
        .filter((r) => r.provider === "codex" && r.status !== "cancelled")
        .every((r) => r.subscription_limits_after?.includes('"usedPercent":37')),
    ).toBe(true);
    expect(
      rows.find((r) => r.provider === "codex" && r.status === "cancelled")
        ?.subscription_limits_after,
    ).toBeNull();
    expect(
      limitDeltas(rows.find((r) => r.provider === "codex" && r.status === "completed")!)[0].delta,
    ).toBe(6);
    expect(discoverCodexModels).toHaveBeenCalledTimes(2);
    expect(engine.cleanupBlockers()).toHaveLength(0);
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("aggregates actual Antigravity step usage idempotently, then uses final reported totals without inventing fields", () => {
  const db = new Database(":memory:");
  try {
    const usage = new Usage(db);
    usage.start("run", {
      task_id: null,
      job_id: null,
      repository: null,
      purpose: "Antigravity Plan",
      provider: "antigravity",
      model: "",
      effort: "high",
    });
    usage.observe("run", {
      event: "init",
      init: { model: "gemini-3.8-flash-high" },
    });
    const step = {
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          thinking_tokens: 1,
          cache_read_tokens: 4,
        },
      },
    };
    usage.observe("run", step);
    usage.observe("run", step);
    usage.observe("run", {
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "DONE",
        usage: { input_tokens: 20, output_tokens: 4 },
      },
    });
    expect(usage.list()[0]).toMatchObject({
      model: "gemini-3.8-flash-high",
      input_tokens: 30,
      output_tokens: 6,
      reasoning_tokens: 1,
      cached_input_tokens: 4,
      total_tokens: null,
    });
    usage.observe("run", {
      event: "result",
      result: { usage: { input_tokens: 31, total_tokens: 39 } },
    });
    expect(usage.list()[0]).toMatchObject({
      input_tokens: 31,
      total_tokens: 39,
    });
    usage.recordLimits("run", {
      reportedAt: now(),
      windows: [{ usedPercent: 20, windowDurationMins: 300, resetsAt: 2000000000 }],
    });
    expect(limitDeltas(usage.list()[0])).toEqual([]);
    usage.recordLimits(
      "run",
      {
        reportedAt: now(),
        windows: [{ usedPercent: 22, windowDurationMins: 300, resetsAt: 2000000200 }],
      },
      true,
    );
    expect(limitDeltas(usage.list()[0])).toEqual([]);
  } finally {
    db.close();
  }
});

it("persists content-bound reviewed state, invalidates modified files and links read-only Ask AI into task context and telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-code-review-"));
  const fixture = new FixtureProvider();
  const requests: Parameters<FixtureProvider["invocation"]>[0][] = [];
  let fail = false;
  const engine = await createFixtureEngine(join(dir, "data"), () => ({
    ...fixture,
    invocation: (request) => {
      if (
        !(request.schema.properties as Record<string, unknown>).summary ||
        Object.keys(request.schema.properties as object).length > 1
      )
        return fixture.invocation(request);
      requests.push(request);
      return {
        program: process.execPath,
        args: [
          "-e",
          fail
            ? "console.error('test failure');process.exit(10)"
            : "(async()=>{let blocked=false;try{await require('node:fs/promises').writeFile('source.txt','MUTATED')}catch{blocked=true}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Task completed'})}}));console.log(JSON.stringify({type:'turn.completed',response:(blocked?'The read-only sandbox prevented edits.':'VIOLATION')+'\\n'+JSON.stringify({summary:'Task completed'}),usage:{input_tokens:40,output_tokens:12,total_tokens:52}}));})();",
        ],
      };
    },
  }));
  const root = engine.root;
  let taskId = "";
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      { title: "Scoped review" },
    );
    taskId = task.id;
    await waitForTask(engine, task.id, (s) => s === "ready_for_review");
    const service = new ReviewService(engine);
    const file = (await service.files(task.id))[0];
    await service.reviewed({
      id: task.id,
      path: file.path,
      reviewed: true,
      expected_hash: file.hash,
    });
    expect((await service.files(task.id))[0].reviewed).toBe(true);
    const current = engine.db.task(task.id);
    const before = await readFile(join(current.worktree_path, "source.txt"), "utf8");
    const answer = await service.ask({
      id: task.id,
      path: "source.txt",
      side: "working",
      line_start: 1,
      line_end: 1,
      question: "Why was this changed?",
      configuration: {
        provider: "codex",
        model: "next-model",
        effort: "low",
        timeout_secs: 30,
      },
    });
    expect(answer).toMatchObject({
      answer: "The read-only sandbox prevented edits.",
      status: "completed",
      selected_code: "A",
    });
    expect(requests[0]).toMatchObject({
      stage: 1,
      cwd: current.worktree_path,
      config: { model: "next-model", effort: "low" },
    });
    expect(requests[0].prompt).toContain('"selectedCode":"A"');
    expect(requests[0].prompt).toContain('"repository":"fixture/fixture"');
    expect(requests[0].prompt).toContain('"lines":[1,1]');
    expect(await readFile(join(current.worktree_path, "source.txt"), "utf8")).toBe(before);
    expect(new Usage(engine.db).list(task.id).find((r) => r.id === answer.run_id)).toMatchObject({
      purpose: "Code Review Ask AI",
      status: "completed",
      input_tokens: 40,
      output_tokens: 12,
      total_tokens: 52,
    });
    expect(engine.db.detail(task.id).messages).toContainEqual(
      expect.objectContaining({
        id: answer.id,
        run_id: answer.run_id,
        status: "review_question",
      }),
    );
    await service.add({
      id: task.id,
      path: answer.path,
      side: answer.side,
      line_start: answer.line_start,
      line_end: answer.line_end,
      content: answer.answer,
    });
    expect(service.list(task.id)[0]).toMatchObject({
      path: "source.txt",
      line_start: 1,
      line_end: 1,
    });
    await writeFile(join(current.worktree_path, "source.txt"), "new code\n");
    expect((await service.files(task.id))[0].reviewed).toBe(false);
    await expect(
      service.reviewed({
        id: task.id,
        path: file.path,
        expected_hash: file.hash,
        reviewed: true,
      }),
    ).rejects.toThrow("changed during review");
    fail = true;
    await expect(
      service.ask({
        id: task.id,
        path: "source.txt",
        side: "working",
        line_start: 1,
        line_end: 1,
        question: "Failed question",
      }),
    ).rejects.toThrow();
    expect(service.questions(task.id).at(-1)).toMatchObject({
      status: "failed",
    });
    expect(engine.db.detail(task.id).messages).toHaveLength(2);
    expect(new Usage(engine.db).list(task.id)).toHaveLength(6);
    engine.db.run(
      "UPDATE task_artifacts SET content='invalid saved JSON' WHERE task_id=? AND stage=1",
      task.id,
    );
    await expect(
      service.ask({
        id: task.id,
        path: "source.txt",
        side: "working",
        line_start: 1,
        line_end: 1,
        question: "Question with corrupt context",
      }),
    ).rejects.toThrow();
    expect(service.questions(task.id).at(-1)).toMatchObject({
      status: "failed",
    });
    expect(engine.db.detail(task.id).messages).toHaveLength(3);
    expect(new Usage(engine.db).list(task.id)).toHaveLength(7);
  } finally {
    await engine.close();
  }
  const reopened = await createFixtureEngine(root);
  try {
    expect(new ReviewService(reopened).questions(taskId)).toHaveLength(3);
    expect(new Usage(reopened.db).list(taskId)).toHaveLength(7);
  } finally {
    await reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("reports stale execution helpers while matching desktop/core builds remain healthy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-helper-build-"));
  try {
    for (const stale of [false, true]) {
      await writeFile(
        join(dir, "core.cjs"),
        `
const {createInterface}=require('node:readline');
const {readFile}=require('node:fs/promises');
const {createHash}=require('node:crypto');
(async()=>{
const build=${stale ? "'older-bundle'" : "createHash('sha256').update(await readFile(__filename)).digest('hex')"};
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const request=JSON.parse(line);const result=request.method==='core.info'?{build,pipeline_approvals:true,manual_pr_analysis:true}:request.method==='snapshot'?{tasks:[]}:request.method==='usage.info'?{database:'test.sqlite'}:null;process.stdout.write(JSON.stringify(result?{id:request.id,result}:{id:request.id,error:{message:'Unknown method: '+request.method}})+'\\n');});
lines.on('close',()=>process.exit(0));
})();
`,
      );
      const bridge = new CoreBridge(dir, {
        distro: "Ubuntu",
        data_home: dir,
        helper_path: "",
      });
      bridge.start();
      try {
        const snapshot = await bridge.request<{ warning?: string }>("snapshot");
        if (stale) {
          expect(snapshot.warning).toContain("differs from this desktop build");
          expect((await bridge.request<{ warning?: string }>("usage.info")).warning).toBe(
            snapshot.warning,
          );
          await expect(bridge.request("newer.method")).rejects.toThrow(
            "Install / update WSL helper",
          );
        } else expect(snapshot.warning).toBeUndefined();
      } finally {
        await bridge.stop();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("discovers editor CLIs and opens task worktrees separately from source checkouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-editor-"));
  const engine = await createFixtureEngine(join(dir, "data"), () => new FixtureProvider());
  const pathBefore = process.env.PATH;
  try {
    const { repo } = await fixtureRepository(engine, dir);
    const task = engine.enqueue(
      repo,
      parseIssue("https://github.com/fixture/fixture/issues/1"),
      "Task A",
      "",
      {},
    );
    await waitForTask(engine, task.id, (s) => s === "ready_for_review");
    const bin = join(dir, "bin");
    await mkdir(bin);
    const output = join(dir, "editor-args.json");
    await writeFile(
      join(bin, "cursor"),
      `#!/usr/bin/env node\nrequire('node:fs/promises').writeFile(${JSON.stringify(output)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${pathBefore}`;
    expect(await discoverEditors()).toContainEqual(
      expect.objectContaining({
        id: "cursor",
        executable: join(bin, "cursor"),
      }),
    );
    engine.db.saveSettings({ ...defaultSettings, default_editor: "cursor" });
    const editor = new Editors(engine);
    expect((await editor.list()).default).toBe("cursor");
    await editor.open(task.id, "task", "cursor");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      argv: [engine.db.task(task.id).worktree_path],
      cwd: engine.db.task(task.id).worktree_path,
    });
    await editor.open(repo.id, "repository", "cursor");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      argv: [repo.path],
      cwd: repo.path,
    });
    process.env.PATH = bin + "/absent";
    await expect(editor.open(task.id, "task", "cursor")).rejects.toThrow("unavailable");
  } finally {
    process.env.PATH = pathBefore;
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("uses fork parent/base for managed clones, publishes progress and cleans cancelled owned clones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-clone-"));
  const engine = await createFixtureEngine(join(dir, "data"));
  const rpc = new Rpc(engine);
  try {
    const { upstream } = await fixtureRepository(engine, dir);
    const source = await readFile(join(upstream, "source.txt"), "utf8");
    vi.spyOn(rpc.github.client, "repository").mockImplementation(async (name) => ({
      id: 1,
      full_name: name,
      name: "repo",
      owner: { login: name.split("/")[0], type: "User" },
      clone_url: `https://github.com/${name}.git`,
      default_branch: name === "me/repo" ? "fork-only" : "main",
      private: false,
      description: null,
      updated_at: now(),
      fork: name === "me/repo",
      archived: false,
      ...(name === "me/repo"
        ? {
            parent: {
              full_name: "upstream/repo",
              clone_url: "https://github.com/upstream/repo.git",
              default_branch: "main",
            },
          }
        : {}),
    }));
    vi.spyOn(rpc.github.client, "detect").mockResolvedValue({
      installed: true,
      connected: false,
      version: "fixture",
      username: null,
      error: null,
    });
    const clone = engine.git.clone;
    vi.spyOn(engine.git, "clone").mockImplementation(async (_, path, signal, progress) => {
      progress?.("Receiving objects: 42% (42/100), 428 MiB | 2 MiB/s");
      await clone(upstream, path, signal, progress);
    });
    vi.spyOn(engine.git, "fetch").mockImplementation(async (repo) => {
      repo.last_fetched = now();
    });
    const events: string[] = [];
    engine.on("event", (e) => events.push(e.event));
    const job = (await rpc.call("github.clone", { repository: "me/repo" })) as {
      id: string;
    };
    await vi.waitFor(() =>
      expect(rpc.github.cloneActivities().find((c) => c.id === job.id)?.status).toBe("completed"),
    );
    const activity = rpc.github.cloneActivities().find((c) => c.id === job.id)!;
    const repo = engine.db.repository(activity.repository_id!);
    expect(repo).toMatchObject({
      owner: "upstream",
      name: "repo",
      upstream_url: "https://github.com/upstream/repo.git",
      origin_url: "https://github.com/me/repo.git",
      base_branch: "main",
      source: "managed",
      connected: true,
      clone_status: "ready",
    });
    expect(repo.path.startsWith(join(engine.root, "repos"))).toBe(true);
    expect(await readFile(join(engine.root, "logs", `clone-${job.id}.log`), "utf8")).toContain(
      "42%",
    );
    expect(events).toContain("changed");
    vi.spyOn(engine.git, "clone").mockImplementation(async (_, path, signal, progress) => {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "partial"), "owned partial data");
      progress?.("Receiving objects: 3%");
      await execute({
        program: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: path,
        signal,
      });
    });
    const pending = rpc.github.startClone("other/repo");
    await vi.waitFor(() => expect(pending.phase).toBe("Receiving objects: 3%"));
    const destination = pending.destination!;
    await rpc.github.cancelClone(pending.id);
    expect(pending.status).toBe("cancelled");
    await expect(readFile(join(destination, "partial"))).rejects.toThrow();
    expect(await readFile(join(upstream, "source.txt"), "utf8")).toBe(source);
    expect(engine.cleanupBlockers()).toHaveLength(0);
  } finally {
    await rpc.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
