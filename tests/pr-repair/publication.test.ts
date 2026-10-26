import { createFixtureEngine } from "../helpers/fixtures";
import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../../backend/execution/engine";
import { checked, execute } from "../../backend/execution/runtime/process";
import { RepairService } from "../../backend/review/repair/service";
import { RepairWorkspaces, repairAssignment } from "../../backend/review/repair/workspace";
import { repairFixture } from "./fixtures";
import { RepairFixtureProvider } from "./provider";
import { Rpc } from "../../backend/rpc";

const preparedFixture = async (engine: Engine, dir: string, push = execute) => {
  const fixture = await repairFixture(engine, dir);
  const { session, repo, fork, upstream } = fixture;

  const workspaces = new RepairWorkspaces(engine.root, engine.git, (_, side) =>
    side === "head" ? fork : upstream,
  );

  const service = new RepairService(
    engine,
    async () => session.identity,
    workspaces,
    () => fork,
    push,
  );

  await workspaces.prepare(session, repo, fixture.checkpoint, new AbortController().signal);
  await writeFile(join(session.workspace.worktree_path, "repair.txt"), "Reviewed repair\n");
  session.status = "awaiting_manual_review";

  session.implementation = {
    summary: "Targeted repair",
    items: session.actions.map((a) => ({
      actionId: a.id,
      status: "implemented",
      files: ["repair.txt"],
      explanation: "Repaired",
      tests: [],
    })),
    tests: [],
    risks: [],
  };

  session.verification = {
    overall: "approved",
    summary: "Read-only review",
    items: session.actions.map((a) => ({
      actionId: a.id,
      status: "accepted",
      files: ["repair.txt"],
      explanation: "Accepted",
    })),
    tests: [
      {
        command: "browser test",
        status: "blocked",
        evidence: "Dependency missing",
      },
    ],
    risks: [],
  };

  session.review_hash = await engine.git.repairFingerprint(repairAssignment(session));
  service.store.save(session);
  return { ...fixture, service };
};

it("refuses publication hook creation through a redirected artifacts parent before any push", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-push-path-"));
  const engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined;
  try {
    const fixture = await preparedFixture(engine, dir);
    service = fixture.service;
    await service.approve(fixture.session.id, fixture.session.review_hash!);
    await service.commit(fixture.session.id, fixture.session.review_hash!, "Reviewed local change");
    const plan = await service.preparePublication(fixture.session.id);
    const external = join(dir, "external");
    await mkdir(external);
    await writeFile(join(external, "canary"), "preserve external artifacts");
    await rename(join(engine.root, "artifacts"), join(engine.root, "artifacts-original"));
    await symlink(external, join(engine.root, "artifacts"));
    await expect(service.publish(fixture.session.id, plan.id)).rejects.toThrow("symlink");
    expect(await readFile(join(external, "canary"), "utf8")).toBe("preserve external artifacts");

    expect(
      await checked("git", ["rev-parse", "refs/heads/fix-translation-tests"], fixture.fork),
    ).toBe(fixture.head);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("requires manual approval, commits only reviewed repair files and pushes the exact fork/ref through normal fast-forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-publish-"));

  const engine = await createFixtureEngine(
    join(dir, "ade"),
    (_, provider) => new RepairFixtureProvider(provider!),
  );

  let rpc: Rpc | undefined;
  let service: RepairService | undefined;
  try {
    const fixture = await preparedFixture(engine, dir);
    const { session, source, fork, head, base, upstream } = fixture;
    service = fixture.service;
    rpc = new Rpc(engine, undefined, service);

    await expect(
      rpc.call("repair.publish", {
        id: session.id,
        publication_id: session.id,
      }),
    ).rejects.toThrow();

    await expect(service.preparePublication(session.id)).rejects.toThrow("manual approval");

    expect(await checked("git", ["rev-parse", "refs/heads/fix-translation-tests"], fork)).toBe(
      head,
    );

    const before = await checked("git", ["status", "--porcelain"], source);
    const index = await readFile(join(source, ".git", "index"));
    const dirtyPlan = await service.approve(session.id, session.review_hash!);

    expect(dirtyPlan.destination).toMatchObject({
      repository: "akshajrawat/oppia",
      branch: "fix-translation-tests",
    });

    expect(dirtyPlan.expected_remote_head).toBe(head);
    expect(dirtyPlan.dirty).toBe(true);

    expect(dirtyPlan.validation).toMatchObject({
      observed_passed: 0,
      reported_blocked: 1,
    });

    await expect(service.publish(session.id, dirtyPlan.id)).rejects.toThrow("clean, committed");

    const message =
      "  Keep this exact title  \n\nDetailed explanation.  \n# This is message text.  ";

    const commit = (await rpc.call("repair.commit", {
      id: session.id,
      expected_hash: session.review_hash!,
      message,
      confirmed: true,
    })) as { head: string; fingerprint: string };

    const object = await execute({
      program: "git",
      args: ["cat-file", "commit", commit.head],
      cwd: session.workspace.worktree_path,
    });

    expect(object.stdout.slice(object.stdout.indexOf("\n\n") + 2)).toBe(message);
    expect(commit.head).not.toBe(session.workspace.integrated_head);
    expect(await readFile(join(source, ".git", "index"))).toEqual(index);
    const plan = await service.preparePublication(session.id);
    expect(plan.local_head).toBe(commit.head);
    expect(plan.dirty).toBe(false);
    expect(plan.changes.files).toBe(2); // upstream README and review repair
    expect(plan.commits.map((c) => c.sha)).toContain(session.workspace.integrated_head);

    const published = (await rpc.call("repair.publish", {
      id: session.id,
      publication_id: plan.id,
      confirmed: true,
    })) as typeof plan;

    expect(published.outcome).toBe("published");
    expect(published.confirmation.confirmed_at).not.toBeNull();

    expect(await checked("git", ["rev-parse", "refs/heads/fix-translation-tests"], fork)).toBe(
      commit.head,
    );

    expect(await checked("git", ["rev-parse", "refs/heads/develop"], upstream)).toBe(base);
    expect(await checked("git", ["status", "--porcelain"], source)).toBe(before);
    expect(await readFile(join(source, ".git", "index"))).toEqual(index);
    expect(service.store.get(session.id).status).toBe("published");
    expect((await service.publish(session.id, plan.id)).outcome).toBe("published");
    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await rpc?.close();
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("rejects stale remote heads, changed reviewed content, closed PRs and lost permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-publish-guards-"));
  const engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined;
  try {
    const fixture = await preparedFixture(engine, dir);
    service = fixture.service;
    const { session, fork, head, source } = fixture;
    await writeFile(join(session.workspace.worktree_path, "repair.txt"), "Changed after review\n");

    await expect(service.approve(session.id, session.review_hash!)).rejects.toThrow(
      "changed since review",
    );

    await writeFile(join(session.workspace.worktree_path, "repair.txt"), "Reviewed repair\n");
    await service.approve(session.id, session.review_hash!);
    const commit = await service.commit(session.id, session.review_hash!, "Local approved repair");
    session.identity.can_push = false;
    await expect(service.preparePublication(session.id)).rejects.toThrow("cannot push");
    session.identity.can_push = true;
    session.identity.state = "closed";
    await expect(service.preparePublication(session.id)).rejects.toThrow("no longer open");
    session.identity.state = "open";
    const plan = await service.preparePublication(session.id);
    await writeFile(join(session.workspace.worktree_path, "repair.txt"), "Post-approval edit\n");
    await expect(service.publish(session.id, plan.id)).rejects.toThrow("changed after publication");
    await writeFile(join(session.workspace.worktree_path, "repair.txt"), "Reviewed repair\n");

    await checked(
      "git",
      ["fetch", "--no-write-fetch-head", session.workspace.worktree_path, "HEAD"],
      fork,
    );

    await checked(
      "git",
      ["update-ref", "refs/heads/fix-translation-tests", session.workspace.integrated_head!],
      fork,
    );

    await expect(service.publish(session.id, plan.id)).rejects.toThrow("Remote PR head changed");

    expect(await checked("git", ["rev-parse", "refs/heads/fix-translation-tests"], fork)).not.toBe(
      commit.head,
    );

    expect(await checked("git", ["rev-parse", "HEAD"], source)).toBe(head);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("rejects a remote-head race at Git's pre-push handshake even when a normal push would fast-forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-push-race-"));
  const engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined;
  try {
    let fork = "",
      raceHead = "",
      repairPath = "";

    const fixture = await preparedFixture(engine, dir, async (request) => {
      expect(request.args.some((arg) => /^--force(?:=|$)/.test(arg))).toBe(false);
      expect(request.args.filter((arg) => arg.startsWith("--force-with-lease="))).toHaveLength(1);
      await checked("git", ["fetch", "--no-write-fetch-head", repairPath, "HEAD"], fork);
      await checked("git", ["update-ref", "refs/heads/fix-translation-tests", raceHead], fork);
      return execute(request);
    });

    service = fixture.service;
    fork = fixture.fork;
    raceHead = fixture.session.workspace.integrated_head!;
    repairPath = fixture.session.workspace.worktree_path;
    await service.approve(fixture.session.id, fixture.session.review_hash!);
    await service.commit(fixture.session.id, fixture.session.review_hash!, "Reviewed fix");
    const plan = await service.preparePublication(fixture.session.id);
    const result = await service.publish(fixture.session.id, plan.id);
    expect(result.outcome).toBe("stale_remote_head");
    expect(result.error).toContain("changed during push; rejected");

    expect(await checked("git", ["rev-parse", "refs/heads/fix-translation-tests"], fork)).toBe(
      raceHead,
    );
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("reconciles an uncertain network outcome without retrying or duplicating publication after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-push-reconcile-"));
  let engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined;
  try {
    let pushes = 0;

    const fixture = await preparedFixture(engine, dir, async (request) => {
      pushes++;
      await execute(request);
      throw new Error("Connection lost after transmission");
    });

    service = fixture.service;
    await service.approve(fixture.session.id, fixture.session.review_hash!);
    await service.commit(fixture.session.id, fixture.session.review_hash!, "Local repair");
    const plan = await service.preparePublication(fixture.session.id);
    expect((await service.publish(fixture.session.id, plan.id)).outcome).toBe("published");
    expect(pushes).toBe(1);
    await service.close();
    await engine.close();
    engine = await createFixtureEngine(join(dir, "ade"));

    service = new RepairService(
      engine,
      async () => fixture.session.identity,
      new RepairWorkspaces(engine.root, engine.git, (_, side) =>
        side === "head" ? fixture.fork : fixture.upstream,
      ),
      () => fixture.fork,
      async () => {
        throw new Error("No restart push is authorized");
      },
    );

    await service.detail(fixture.session.id);
    expect((await service.publish(fixture.session.id, plan.id)).outcome).toBe("published");
    expect(pushes).toBe(1);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);

it("keeps an approved local commit without requiring push permission or creating a publication attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibestar-pr-local-only-"));
  const engine = await createFixtureEngine(join(dir, "ade"));
  let service: RepairService | undefined;
  try {
    const fixture = await preparedFixture(engine, dir);
    service = fixture.service;
    fixture.session.identity.can_push = false;
    await service.approveLocal(fixture.session.id, fixture.session.review_hash!);

    const commit = await service.commit(
      fixture.session.id,
      fixture.session.review_hash!,
      "Reviewed local-only repair",
    );

    await service.keepLocal(fixture.session.id);
    expect(service.store.get(fixture.session.id).status).toBe("awaiting_manual_review");

    expect(
      await checked("git", ["rev-parse", "HEAD"], fixture.session.workspace.worktree_path),
    ).toBe(commit.head);

    expect(
      await checked("git", ["rev-parse", "refs/heads/fix-translation-tests"], fixture.fork),
    ).toBe(fixture.head);

    expect(engine.db.all("SELECT * FROM repair_publications")).toEqual([]);
  } finally {
    await service?.close();
    await engine.close();
    await rm(dir, { recursive: true });
  }
}, 30000);
