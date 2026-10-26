import { createFixtureEngine } from "../helpers/fixtures";
import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { RepairService } from "../../backend/review/repair/service";
import { RepairWorkspaces } from "../../backend/review/repair/workspace";
import { repairFixture } from "./fixtures";
import { RepairFixtureProvider } from "./provider";

const waitForRepair = (service: RepairService, id: string) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      service.engine.off("event", check);
      reject(new Error("Repair transition deadline"));
    }, 20000);

    const check = () => {
      const state = service.store.get(id).status;
      if (
        [
          "awaiting_manual_review",
          "verification_blocked",
          "failed",
          "cancelled",
          "merge_conflict",
        ].includes(state) &&
        !service.isActive(id)
      ) {
        clearTimeout(timer);
        service.engine.off("event", check);
        resolve();
      }
    };

    service.engine.on("event", check);
    check();
  });

it("implements selected manual PR feedback through Codex then a read-only Antigravity review and stops at manual review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-pipeline-"));
  const order: string[] = [];

  const engine = await createFixtureEngine(join(dir, "ade"), (_, provider) => {
    order.push(provider!);
    return new RepairFixtureProvider(provider!, {
      readonlyProbe: provider === "antigravity",
    });
  });

  let service: RepairService | undefined;
  try {
    const fixture = await repairFixture(engine, dir);
    const { session, repo, fork, upstream, source } = fixture;

    service = new RepairService(
      engine,
      async () => session.identity,
      new RepairWorkspaces(engine.root, engine.git, (_, side) =>
        side === "head" ? fork : upstream,
      ),
    );

    session.configuration.codex = {
      model: "repair-model",
      effort: "xhigh",
      timeout_secs: 60,
    };

    session.configuration.antigravity = {
      model: "repair-model",
      effort: "high",
      timeout_secs: 60,
    };

    service.store.save(session);
    await service.start(session.id);
    await waitForRepair(service, session.id);
    const result = service.store.get(session.id);
    expect(result.error).toBeNull();
    expect(result.status).toBe("awaiting_manual_review");
    expect(order).toEqual(["codex", "antigravity"]);

    expect(result.implementation?.items.map((i) => i.actionId)).toEqual(
      session.actions.map((a) => a.id),
    );

    expect(result.verification?.items.every((i) => i.status === "accepted")).toBe(true);
    expect(result.verification?.tests.some((t) => t.status === "blocked")).toBe(true);
    expect(result.review_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(engine.db.tasks()).toEqual([]);

    const runs = engine.db.all<{
      provider: string;
      model: string;
      effort: string;
      task_id: string | null;
    }>("SELECT * FROM agent_runs WHERE repair_id=? ORDER BY started_at,rowid", session.id);

    expect(runs.map((r) => [r.provider, r.model, r.effort, r.task_id])).toEqual([
      ["codex", "repair-model", "xhigh", null],
      ["antigravity", "repair-model", "high", null],
    ]);

    const tests = engine.db.all<{
      status: string;
      exit_code: number;
      stdout: string;
    }>("SELECT * FROM test_runs WHERE repair_id=?", session.id);

    expect(tests).toHaveLength(2);

    expect(
      tests.every(
        (t) => t.status === "passed" && t.exit_code === 0 && t.stdout.includes("# pass 3"),
      ),
    ).toBe(true);

    const usage = engine.db.all<{
      total_tokens: number | null;
      input_tokens: number;
    }>("SELECT * FROM ai_usage WHERE repair_id=?", session.id);

    expect(usage).toHaveLength(2);
    expect(usage.every((u) => u.input_tokens === 40 && u.total_tokens === null)).toBe(true);

    expect(await readFile(join(source, "README.md"), "utf8")).toBe(
      "Personal dirty source checkout\n",
    );

    await expect(service.start(session.id)).rejects.toThrow("Describe the further fix");
    const instructionRequest = randomUUID();

    await service.start(
      session.id,
      "Check the independent review again and retain the same worktree",
      instructionRequest,
    );

    await service.start(
      session.id,
      "Check the independent review again and retain the same worktree",
      instructionRequest,
    );

    await waitForRepair(service, session.id);

    expect(service.store.get(session.id).workspace.worktree_path).toBe(
      result.workspace.worktree_path,
    );

    expect(engine.db.all("SELECT * FROM agent_runs WHERE repair_id=?", session.id)).toHaveLength(4);

    expect(
      engine.db.all("SELECT * FROM repair_messages WHERE repair_id=?", session.id),
    ).toHaveLength(1);

    await service.start(
      session.id,
      "Check the independent review again and retain the same worktree",
      instructionRequest,
    );

    expect(engine.db.all("SELECT * FROM agent_runs WHERE repair_id=?", session.id)).toHaveLength(4);

    await expect(service.start(session.id, "Changed payload", instructionRequest)).rejects.toThrow(
      "different content",
    );

    expect(repo.path).toBe(source);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 40000);

it("validates selections and creates repairs from analyses without original issue tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-create-"));

  const engine = await createFixtureEngine(
    join(dir, "ade"),
    (_, provider) =>
      new RepairFixtureProvider(provider!, {
        blocked: provider === "antigravity",
      }),
  );

  let service: RepairService | undefined;
  try {
    const { session, fork, upstream } = await repairFixture(engine, dir);

    service = new RepairService(
      engine,
      async () => session.identity,
      new RepairWorkspaces(engine.root, engine.git, (_, side) =>
        side === "head" ? fork : upstream,
      ),
    );

    const request = {
      request_id: randomUUID(),
      job_id: session.job_id,
      repository_id: session.repo_id,
      analysis_id: session.analysis_id,
      action_ids: session.actions.map((a) => a.id),
      instructions: "Keep questions as local explanations",
    };

    await expect(service.create({ ...request, action_ids: [randomUUID()] })).rejects.toThrow(
      "outstanding review observations",
    );

    const created = await service.create(request);
    expect(created.id).toBe(request.request_id);
    await waitForRepair(service, created.id);
    expect(service.store.get(created.id).status).toBe("verification_blocked");
    expect(await service.create(request)).toMatchObject({ id: created.id });

    await expect(service.create({ ...request, instructions: "different" })).rejects.toThrow(
      "another repair selection",
    );
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("rejects incomplete item reports and preserves cancellation without starting verification or replaying models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-cancel-"));
  let waiting = false;

  const engine = await createFixtureEngine(
    join(dir, "ade"),
    (_, provider) =>
      new RepairFixtureProvider(provider!, {
        missingItem: !waiting,
        wait: waiting,
      }),
  );

  let service: RepairService | undefined;
  try {
    const { session, fork, upstream } = await repairFixture(engine, dir);

    service = new RepairService(
      engine,
      async () => session.identity,
      new RepairWorkspaces(engine.root, engine.git, (_, side) =>
        side === "head" ? fork : upstream,
      ),
    );

    await service.start(session.id);
    await waitForRepair(service, session.id);
    expect(service.store.get(session.id).status).toBe("failed");
    expect(service.store.get(session.id).error).toContain("exactly one result");
    expect(engine.db.all("SELECT * FROM agent_runs WHERE repair_id=?", session.id)).toHaveLength(1);
    waiting = true;
    await service.start(session.id, "Try the selected items again explicitly");

    await new Promise<void>((resolve) => {
      const check = () => {
        if (service!.store.get(session.id).status === "codex_implementing") {
          engine.off("event", check);
          resolve();
        }
      };

      engine.on("event", check);
      check();
    });

    await service.cancel(session.id);
    expect(service.store.get(session.id).status).toBe("cancelled");

    expect(
      engine.db.all(
        "SELECT * FROM agent_runs WHERE repair_id=? AND provider='antigravity'",
        session.id,
      ),
    ).toHaveLength(0);

    const count = engine.db.all("SELECT * FROM ai_usage").length;
    await service.close();

    service = new RepairService(
      engine,
      async () => session.identity,
      new RepairWorkspaces(engine.root, engine.git, (_, side) =>
        side === "head" ? fork : upstream,
      ),
    );

    await service.detail(session.id);
    expect(engine.db.all("SELECT * FROM ai_usage")).toHaveLength(count);

    await writeFile(
      join(service.store.get(session.id).workspace.worktree_path, "keep.txt"),
      "Preserve cancelled changes\n",
    );
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
