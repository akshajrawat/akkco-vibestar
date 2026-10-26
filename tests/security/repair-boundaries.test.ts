import { expect, it, vi } from "vitest";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RepairService } from "../../backend/review/repair/service";
import { RepairWorkspaces } from "../../backend/review/repair/workspace";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";
import { repairFixture } from "../pr-repair/fixtures";
import { securityWorkspace } from "./fixtures";
import { Rpc } from "../../backend/rpc";
import { now, type Task } from "../../backend/domain";
import { randomUUID } from "node:crypto";

it("refuses repair history deletion through a post-startup managed logs alias", async () => {
  const { dir, root } = await securityWorkspace();
  const engine = await createFixtureEngine(root);
  let service: RepairService | undefined;
  try {
    const fixture = await repairFixture(engine, dir);
    service = new RepairService(engine, async () => fixture.session.identity);
    await service.detail(fixture.session.id);
    const session = service.store.get(fixture.session.id);
    session.workspace.preparation = "removed";
    service.store.save(session);
    const external = join(dir, "external");
    await mkdir(join(external, session.id), { recursive: true });
    const canary = join(external, session.id, "canary");
    await writeFile(canary, "preserve external history");
    await rename(join(root, "logs"), join(root, "logs-original"));
    await symlink(external, join(root, "logs"));
    await expect(service.cleanup(session.id, true)).rejects.toThrow("symlink");
    expect(await readFile(canary, "utf8")).toBe("preserve external history");
    expect(service.store.get(session.id).id).toBe(session.id);
  } finally {
    await service?.close();
    await engine.close();
  }
});

it("refuses a managed repository parent redirected to an external source before repair preparation", async () => {
  const { dir, root } = await securityWorkspace();
  const engine = await createFixtureEngine(root);
  try {
    const fixture = await repairFixture(engine, dir, {
      imported: false,
      conflict: false,
    });

    const relocated = join(dir, "relocated-source");
    await rename(fixture.source, relocated);
    await symlink(relocated, fixture.source);
    const before = await readFile(join(relocated, ".git", "config"));

    const workspaces = new RepairWorkspaces(root, engine.git, (_, side) =>
      side === "head" ? fixture.fork : fixture.upstream,
    );

    await expect(
      workspaces.validateRepository(fixture.repo, fixture.session.identity),
    ).rejects.toThrow("symlink");

    await expect(
      workspaces.prepare(
        fixture.session,
        fixture.repo,
        fixture.checkpoint,
        new AbortController().signal,
      ),
    ).rejects.toThrow("symlink");

    expect(await readFile(join(relocated, ".git", "config"))).toEqual(before);

    expect(await readFile(join(relocated, "README.md"), "utf8")).toBe(
      "Personal dirty source checkout\n",
    );
  } finally {
    await engine.close();
  }
});

it("requires current final-review authority for completion and retains legacy completed history", async () => {
  const { dir, root, task: workspace } = await securityWorkspace();
  const engine = await createFixtureEngine(root);
  const rpc = new Rpc(engine);
  try {
    const { repo } = await repairFixture(engine, dir);

    const task: Task = {
      ...workspace,
      repo_id: repo.id,
      id: randomUUID(),
      issue_number: 1,
      issue_url: "https://github.com/oppia/oppia/issues/1",
      claimed_scope: "legacy",
      notes: "",
      issue: {},
      base_branch: "main",
      status: "ready_for_review",
      stage: 6,
      error: null,
      created_at: now(),
      updated_at: now(),
    };

    for (const hash of [undefined, "a".repeat(64)]) {
      engine.db.saveTask({ ...task, final_review_hash: hash });

      await expect(rpc.call("task.complete", { id: task.id })).rejects.toThrow(
        "older integrity method",
      );

      expect(engine.db.task(task.id).status).toBe("ready_for_review");
    }

    engine.db.saveTask({
      ...task,
      status: "completed",
      final_review_hash: "a".repeat(64),
    });

    expect(engine.db.task(task.id)).toMatchObject({
      status: "completed",
      final_review_hash: "a".repeat(64),
    });

    expect(engine.db.all("SELECT * FROM ai_usage")).toEqual([]);
  } finally {
    await rpc.close();
    await engine.close();
  }
});

it("refuses repair context writes through a redirected artifacts parent before starting an agent", async () => {
  const { dir, root } = await securityWorkspace();
  let agents = 0;

  const engine = await createFixtureEngine(root, () => {
    agents++;
    return new FixtureProvider();
  });

  let service: RepairService | undefined;
  try {
    const fixture = await repairFixture(engine, dir);

    const workspaces = new RepairWorkspaces(root, engine.git, (_, side) =>
      side === "head" ? fixture.fork : fixture.upstream,
    );

    service = new RepairService(engine, async () => fixture.session.identity, workspaces);
    const external = join(dir, "external");
    await mkdir(external);
    await writeFile(join(external, "canary"), "preserve external artifacts");
    await rename(join(root, "artifacts"), join(root, "artifacts-original"));
    await symlink(external, join(root, "artifacts"));
    await service.start(fixture.session.id);

    await vi.waitFor(() => expect(service!.store.get(fixture.session.id).status).toBe("failed"), {
      timeout: 10000,
    });

    expect(service.store.get(fixture.session.id).error).toContain("symlink");
    expect(agents).toBe(0);
    expect(await readFile(join(external, "canary"), "utf8")).toBe("preserve external artifacts");
  } finally {
    await service?.close();
    await engine.close();
  }
}, 20000);
