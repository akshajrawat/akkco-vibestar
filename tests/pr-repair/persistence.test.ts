import { createFixtureEngine } from "../fixtures";
import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capture,
  checked,
  processIdentity,
} from "../../backend/execution/process";
import { spawn } from "node:child_process";
import { RepairService } from "../../backend/review/repair/service";
import { RepairWorkspaces } from "../../backend/review/repair/workspace";
import { repairFixture } from "./fixtures";
import { migrateDataRoot } from "../../backend/storage/migrate-root";
import { TaskTerminals } from "../../backend/execution/task-terminals";
import { StorageService } from "../../backend/storage/service";
import { repairAssignment } from "../../backend/review/repair/workspace";

it("reconciles an actual core restart during preparation without replaying a merge or inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-restart-"));
  let engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined;
  try {
    const { repo, session, checkpoint, fork, upstream } = await repairFixture(
      engine,
      dir,
    );
    const workspaces = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    await workspaces.prepare(
      session,
      repo,
      checkpoint,
      new AbortController().signal,
    );
    const integrated = session.workspace.integrated_head;
    const detached = spawn("git", ["cat-file", "--batch"], {
      cwd: repo.path,
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    await new Promise<void>((resolve, reject) => {
      detached.once("spawn", resolve);
      detached.once("error", reject);
    });
    const exited = new Promise<void>((resolve) =>
      detached.once("exit", () => resolve()),
    );
    session.workspace.operation = {
      kind: "fetch",
      pid: detached.pid!,
      identity: await processIdentity(detached.pid!),
      started_at: new Date().toISOString(),
    };
    session.status = "preparing";
    session.workspace.merge_state = "intent";
    session.workspace.preparation = "merging";
    checkpoint();
    await engine.close();
    engine = await createFixtureEngine(join(dir, "ade"));
    await exited;
    expect(detached.signalCode).toBe("SIGKILL");
    const recovered = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    service = new RepairService(
      engine,
      async () => session.identity,
      recovered,
      () => fork,
    );
    await service.detail(session.id);
    expect(service.store.get(session.id).status).toBe("interrupted");
    expect(service.store.get(session.id).workspace.preparation).toBe("ready");
    expect(
      await checked(
        "git",
        ["rev-parse", "HEAD"],
        session.workspace.worktree_path,
      ),
    ).toBe(integrated);
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("protects source/repair ownership during cleanup and retains reviewed state only for unchanged file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-cleanup-"));
  const engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined;
  try {
    const fixture = await repairFixture(engine, dir);
    const { repo, session, checkpoint, fork, upstream, source } = fixture;
    const workspaces = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    await workspaces.prepare(
      session,
      repo,
      checkpoint,
      new AbortController().signal,
    );
    service = new RepairService(
      engine,
      async () => session.identity,
      workspaces,
      () => fork,
    );
    const storage = new StorageService(engine);
    await expect(storage.removeRepository(repo.id)).rejects.toThrow(
      "PR repair workspaces",
    );
    const resetPreview = await storage.previewReset();
    expect(resetPreview.repairs.map((repair) => repair.id)).toContain(
      session.id,
    );
    await expect(storage.reset()).rejects.toThrow("preview");
    const file = join(session.workspace.worktree_path, "spec.ts");
    const unusual = join(
      session.workspace.worktree_path,
      "ghp_abcdefghijklmnopqrstuvwxyz1234567890.txt",
    );
    await writeFile(unusual, "Reviewed bytes\n");
    const before = await engine.git.repairFingerprint(
      repairAssignment(session),
    );
    await writeFile(unusual, "Changed bytes\n");
    expect(
      await engine.git.repairFingerprint(repairAssignment(session)),
    ).not.toBe(before);
    await rm(unusual);
    const original = await readFile(file, "utf8");
    await writeFile(file, `${original}// review repair\n`);
    const review = (await service.reviewFiles(session.id)).find(
      (row) => row.path === "spec.ts",
    )!;
    await service.reviewed(session.id, review.path, null, review.hash, true);
    expect(
      (await service.reviewFiles(session.id)).find(
        (row) => row.path === "spec.ts",
      )?.reviewed,
    ).toBe(true);
    await writeFile(file, `${original}// changed after file review\n`);
    expect(
      (await service.reviewFiles(session.id)).find(
        (row) => row.path === "spec.ts",
      )?.reviewed,
    ).toBe(false);
    await expect(
      service.reviewed(session.id, review.path, null, review.hash, true),
    ).rejects.toThrow("changed during review");
    await expect(service.cleanup(session.id, false)).rejects.toThrow(
      "local changes",
    );
    await writeFile(file, original);
    const removing = service.store.get(session.id);
    removing.workspace.cleanup_head = await checked(
      "git",
      ["rev-parse", "HEAD"],
      removing.workspace.worktree_path,
    );
    removing.workspace.preparation = "removing";
    service.store.save(removing);
    await checked(
      "git",
      ["worktree", "remove", "--", removing.workspace.worktree_path],
      source,
    );
    await service.cleanup(session.id, false);
    expect(service.store.get(session.id).workspace.preparation).toBe("removed");
    expect(
      (
        await capture(
          "git",
          [
            "show-ref",
            "--verify",
            `refs/heads/${session.workspace.branch_name}`,
          ],
          source,
        )
      ).code,
    ).not.toBe(0);
    expect(await readFile(join(source, "personal.txt"), "utf8")).toBe(
      "Preserve this untracked file\n",
    );
    await service.cleanup(session.id, true);
    expect(service.store.list()).toEqual([]);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("migrates a managed repair root while preserving ownership, checkpoints and source data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-migration-"));
  const oldRoot = join(dir, "old"),
    newRoot = join(dir, "new");
  let engine = await createFixtureEngine(oldRoot);
  let service: RepairService | undefined;
  try {
    const { repo, session, checkpoint, fork, upstream } = await repairFixture(
      engine,
      dir,
      { imported: false, conflict: false },
    );
    const workspace = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    await workspace.prepare(
      session,
      repo,
      checkpoint,
      new AbortController().signal,
    );
    await engine.close();
    await migrateDataRoot(oldRoot, newRoot);
    engine = await createFixtureEngine(newRoot);
    service = new RepairService(
      engine,
      async () => session.identity,
      new RepairWorkspaces(engine.root, engine.git, (_, side) =>
        side === "head" ? fork : upstream,
      ),
      () => fork,
    );
    const migrated = service.store.get(session.id);
    expect(migrated.workspace.worktree_path.startsWith(newRoot)).toBe(true);
    expect(migrated.workspace.git_common_dir.startsWith(newRoot)).toBe(true);
    expect(await service.openPath(session.id)).toBe(
      migrated.workspace.worktree_path,
    );
    expect(
      await checked(
        "git",
        ["rev-parse", "HEAD"],
        migrated.workspace.worktree_path,
      ),
    ).toBe(session.workspace.integrated_head);
    expect(await readFile(join(repo.path, "personal.txt"), "utf8")).toBe(
      "Preserve this untracked file\n",
    );
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("runs real repair PTYs with exclusive leases and prevents concurrent agent/Git operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-terminal-"));
  const engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined, terminals: TaskTerminals | undefined;
  try {
    const { repo, session, checkpoint, fork, upstream } = await repairFixture(
      engine,
      dir,
    );
    const workspaces = new RepairWorkspaces(
      engine.root,
      engine.git,
      (_, side) => (side === "head" ? fork : upstream),
    );
    await workspaces.prepare(
      session,
      repo,
      checkpoint,
      new AbortController().signal,
    );
    service = new RepairService(
      engine,
      async () => session.identity,
      workspaces,
      () => fork,
    );
    terminals = new TaskTerminals(engine, {
      assignment: service.assignment,
      acquire: service.acquireTerminal,
    });
    const terminal = await terminals.open(session.id, 100, 20);
    expect(service.isActive(session.id)).toBe(true);
    await expect(service.start(session.id)).rejects.toThrow("already running");
    await expect(service.cleanup(session.id, false)).rejects.toThrow(
      "already in use",
    );
    const output = new Promise<string>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => {
        engine.off("event", read);
        reject(new Error("PTY output deadline"));
      }, 10000);
      const read = (event: {
        event: string;
        repair_id?: string;
        text?: string;
      }) => {
        if (
          event.repair_id === session.id &&
          event.event === "terminal.output"
        ) {
          text += event.text;
          if (text.includes("REPAIR_PTY_VERIFIED")) {
            clearTimeout(timer);
            engine.off("event", read);
            resolve(text);
          }
        }
      };
      engine.on("event", read);
    });
    terminals.input(
      session.id,
      terminal.session_id,
      "printf 'REPAIR_PTY_VERIFIED\\n'\r",
    );
    expect(await output).toContain("REPAIR_PTY_VERIFIED");
    await terminals.close(session.id);
    expect(service.isActive(session.id)).toBe(false);
    expect(
      engine.db.all<{ task_id: string | null }>(
        "SELECT * FROM terminal_sessions WHERE repair_id=?",
        session.id,
      )[0].task_id,
    ).toBeNull();
  } finally {
    await terminals?.dispose();
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
