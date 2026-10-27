import { expect, it, vi } from "vitest";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { FinalizationService } from "../../backend/finalization/service";
import { checked, execute } from "../../backend/execution/runtime/process";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";
import { finalizationFixture } from "./fixtures";

const committedFixture = async () => {
  const fixture = await finalizationFixture();
  const record = await fixture.preview();
  await fixture.service.approve(fixture.task.id, record.id);

  const committed = await fixture.service.commit(
    fixture.task.id,
    record.id,
    "Reviewed contribution",
    true,
  );

  return { ...fixture, record: committed };
};

it("preflights an exact destination without committing, preparing publication or bypassing strict RPC validation", async () => {
  const f = await finalizationFixture();
  try {
    const record = await f.preview();
    const destination = { remote: "origin", branch: f.task.branch_name };
    const before = await checked("git", ["rev-parse", "HEAD"], f.task.worktree_path);

    const result = await f.service.call("checkDestination", {
      id: f.task.id,
      operation_id: record.id,
      destination,
    });

    expect(result).toMatchObject({
      repository: "contributor/fixture",
      repository_id: "fork-42",
      branch: f.task.branch_name,
    });

    expect(await checked("git", ["rev-parse", "HEAD"], f.task.worktree_path)).toBe(before);

    expect(f.service.store.get(f.task.id, record.id)).toMatchObject({
      status: "reviewed",
      destination: null,
      head: null,
    });

    await expect(
      f.service.call("checkDestination", {
        id: f.task.id,
        operation_id: record.id,
        destination,
        shell: "hostile",
      }),
    ).rejects.toThrow();

    await expect(f.service.publish(f.task.id, record.id, true)).rejects.toThrow(
      "Prepare and explicitly confirm",
    );
  } finally {
    await f.close();
  }
}, 30000);

it.each(["owner", "collaborator"])(
  "publishes to a verified writable source repository for an %s without requiring a fork",
  async (role) => {
    const f = await committedFixture();

    const direct = {
      id: "source-verified-42",
      full_name: "fixture/fixture",
      permissions: { push: true },
      fork: false,
      viewer: role === "owner" ? "fixture" : "collaborator",
    };

    const push = vi.fn(execute);

    const service = new FinalizationService(
      f.engine,
      async () => direct,
      (url) => {
        expect(url).toBe(f.repo.upstream_url);
        return f.fork;
      },
      push,
    );

    try {
      f.repo.origin_url = null;
      f.engine.db.saveRepository(f.repo);

      const prepared = await service.prepare(f.task.id, f.record.id, {
        remote: "upstream",
        branch: f.task.branch_name,
      });

      expect(prepared.destination).toMatchObject({
        repository: "fixture/fixture",
        repository_id: direct.id,
        viewer: direct.viewer,
      });

      expect(push).not.toHaveBeenCalled();

      await expect(
        service.call("publish", {
          id: f.task.id,
          operation_id: f.record.id,
          skip_hooks: true,
          confirmed: false,
        }),
      ).rejects.toThrow();

      expect(push).not.toHaveBeenCalled();

      expect(
        await service.call("publish", {
          id: f.task.id,
          operation_id: f.record.id,
          skip_hooks: true,
          confirmed: true,
        }),
      ).toMatchObject({ status: "published" });

      expect(push).toHaveBeenCalledOnce();

      expect(await checked("git", ["rev-parse", `refs/heads/${f.task.branch_name}`], f.fork)).toBe(
        f.record.head,
      );
    } finally {
      await service.close();
      await f.close();
    }
  },
  30000,
);

it("keeps a local commit when neither a writable source nor a contribution fork is available", async () => {
  const f = await committedFixture();
  const push = vi.fn(execute);

  const service = new FinalizationService(
    f.engine,
    async () => ({
      id: "source-42",
      full_name: "fixture/fixture",
      permissions: { push: false },
      fork: false,
      viewer: "visitor",
    }),
    f.transport,
    push,
  );

  try {
    f.repo.origin_url = null;
    f.engine.db.saveRepository(f.repo);

    await expect(
      service.prepare(f.task.id, f.record.id, { remote: "upstream", branch: f.task.branch_name }),
    ).rejects.toThrow("cannot publish");

    expect(service.store.get(f.task.id, f.record.id)).toMatchObject({
      status: "committed",
      head: f.record.head,
    });

    expect(push).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await f.close();
  }
}, 30000);

it("binds normal hook configuration to the preview instead of silently changing it after approval", async () => {
  const f = await finalizationFixture();
  try {
    const record = await f.preview();
    await f.service.approve(f.task.id, record.id);

    await checked(
      "git",
      ["config", "--local", "core.hooksPath", "/dev/null"],
      f.task.worktree_path,
    );

    await expect(f.service.commit(f.task.id, record.id, "Exact", false)).rejects.toThrow(
      "configuration changed",
    );

    expect(await checked("git", ["rev-parse", "HEAD"], f.task.worktree_path)).toBe(record.parent);
    expect((await f.service.commit(f.task.id, record.id, "Exact", true)).status).toBe("committed");
  } finally {
    await f.close();
  }
}, 30000);

it("honors configured local hook paths and refuses missing projected hooks instead of silently skipping", async () => {
  const f = await finalizationFixture();
  try {
    await mkdir(join(f.task.worktree_path, ".review-hooks"));

    await writeFile(
      join(f.task.worktree_path, ".review-hooks", "pre-commit"),
      "#!/bin/sh\nexit 17\n",
      { mode: 0o755 },
    );

    await checked(
      "git",
      ["config", "--local", "core.hooksPath", ".review-hooks"],
      f.task.worktree_path,
    );

    const omitted = await f.preview();
    await f.service.review(f.task.id, omitted.id);
    await f.service.approve(f.task.id, omitted.id);

    await expect(f.service.commit(f.task.id, omitted.id, "Selected fix", false)).rejects.toThrow(
      "missing from the selected review workspace",
    );

    const included = await f.preview(["source.txt", ".review-hooks/pre-commit"]);
    await f.service.review(f.task.id, included.id);
    await f.service.approve(f.task.id, included.id);

    await expect(f.service.commit(f.task.id, included.id, "Selected fix", false)).rejects.toThrow(
      "pre-commit exited 17",
    );

    expect((await f.service.commit(f.task.id, included.id, "Selected fix", true)).status).toBe(
      "committed",
    );
  } finally {
    await f.close();
  }
}, 30000);

it("rechecks a typed destination without recreating the reviewed local commit", async () => {
  const f = await committedFixture();
  try {
    await f.service.prepare(f.task.id, f.record.id);

    const destination = {
      remote: "origin",
      branch: "contribution/another-feature",
    };

    const updated = await f.service.call("prepare", {
      id: f.task.id,
      operation_id: f.record.id,
      destination,
    });

    expect(updated).toMatchObject({
      status: "prepared",
      head: f.record.head,
      destination,
    });

    await expect(
      f.service.call("prepare", {
        id: f.task.id,
        operation_id: f.record.id,
        destination: { ...destination, force: true },
      }),
    ).rejects.toThrow();

    await f.service.publish(f.task.id, f.record.id, true);

    expect(await checked("git", ["rev-parse", `refs/heads/${destination.branch}`], f.fork)).toBe(
      f.record.head,
    );

    expect(
      await checked(
        "git",
        ["for-each-ref", "--format=%(refname)", `refs/heads/${f.task.branch_name}`],
        f.fork,
      ),
    ).toBe("");

    expect(f.service.store.list(f.task.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

it("runs optional hooks in the sandbox and skips them only on explicit choices", async () => {
  const f = await finalizationFixture();
  try {
    const hooks = join(f.repo.path, ".git", "hooks");
    await mkdir(hooks, { recursive: true });

    await writeFile(
      join(hooks, "pre-commit"),
      "#!/bin/sh\nprintf 'optional commit check failed\\n'\nexit 19\n",
      { mode: 0o700 },
    );

    const record = await f.preview();
    await f.service.approve(f.task.id, record.id);

    await expect(f.service.commit(f.task.id, record.id, "Exact", false)).rejects.toThrow(
      "pre-commit exited 19",
    );

    expect(await checked("git", ["rev-parse", "HEAD"], f.task.worktree_path)).toBe(record.parent);
    await f.service.commit(f.task.id, record.id, "Exact", true);
    await f.service.prepare(f.task.id, record.id);

    await writeFile(
      join(hooks, "pre-push"),
      "#!/bin/sh\nprintf 'optional push check failed\\n'\nexit 23\n",
      { mode: 0o700 },
    );

    await expect(f.service.publish(f.task.id, record.id, false)).rejects.toThrow(
      "pre-push exited 23",
    );

    const result = await f.service.publish(f.task.id, record.id, true);
    expect(result.status).toBe("published");
    const events = f.service.store.events(record.id);

    expect(
      events.some((event) => event.phase === "Optional pre-commit" && event.exit_code === 19),
    ).toBe(true);

    expect(
      events.some((event) => event.phase === "Optional pre-push" && event.exit_code === 23),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 30000);

it("rejects wrong remotes, changed permissions, viewers, branches and approved contents before any push", async () => {
  const f = await committedFixture();
  try {
    await checked(
      "git",
      ["remote", "set-url", "origin", "https://github.com/other/fixture.git"],
      f.repo.path,
    );

    await expect(f.service.prepare(f.task.id, f.record.id)).rejects.toThrow(
      "configured contribution",
    );

    await checked("git", ["remote", "set-url", "origin", f.repo.origin_url!], f.repo.path);
    f.identity.permissions.push = false;
    await expect(f.service.prepare(f.task.id, f.record.id)).rejects.toThrow("cannot publish");
    f.identity.permissions.push = true;
    await f.service.prepare(f.task.id, f.record.id);
    f.identity.viewer = "another-account";

    await expect(f.service.publish(f.task.id, f.record.id, true)).rejects.toThrow(
      "changed after preparation",
    );

    f.identity.viewer = "contributor";
    const changed = f.service.store.get(f.task.id, f.record.id);
    changed.preset.branch = "another-target";
    f.service.store.save(changed);

    await expect(f.service.publish(f.task.id, f.record.id, true)).rejects.toThrow(
      "changed after preparation",
    );

    changed.preset.branch = f.task.branch_name;
    f.service.store.save(changed);
    await writeFile(join(f.task.worktree_path, "source.txt"), "changed after commit\n");
    await expect(f.service.publish(f.task.id, f.record.id, true)).rejects.toThrow("changed");

    expect(
      await checked(
        "git",
        ["for-each-ref", "--format=%(refname)", `refs/heads/${f.task.branch_name}`],
        f.fork,
      ),
    ).toBe("");
  } finally {
    await f.close();
  }
}, 30000);

it("rejects a new-branch race with --no-verify even when the raced head would be an ancestor", async () => {
  const f = await committedFixture();

  const push = vi.fn(async (request: Parameters<typeof execute>[0]) => {
    expect(request.args).toContain("--no-verify");

    await checked(
      "git",
      ["update-ref", `refs/heads/${f.task.branch_name}`, f.record.parent],
      f.fork,
    );

    return execute(request);
  });

  const service = new FinalizationService(f.engine, async () => f.identity, f.transport, push);
  try {
    await service.prepare(f.task.id, f.record.id);
    const result = await service.publish(f.task.id, f.record.id, true);
    expect(push).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");

    expect(await checked("git", ["rev-parse", `refs/heads/${f.task.branch_name}`], f.fork)).toBe(
      f.record.parent,
    );

    expect(
      service.store
        .events(f.record.id)
        .some((event) => event.exit_code !== null && event.exit_code !== 0),
    ).toBe(true);
  } finally {
    await service.close();
    await f.close();
  }
}, 30000);

it("reconciles a network interruption after a successful push across restart without pushing twice", async () => {
  const f = await committedFixture();
  let disconnected = false;

  const push = vi.fn(async (request: Parameters<typeof execute>[0]) => {
    await execute(request);
    disconnected = true;
    throw new Error("Fixture connection closed after remote accepted");
  });

  const transport = (url: string) => {
    if (disconnected) throw new Error("Fixture remote unavailable");
    return f.transport(url);
  };

  const service = new FinalizationService(f.engine, async () => f.identity, transport, push);
  let reopened: Awaited<ReturnType<typeof createFixtureEngine>> | undefined;
  try {
    await service.prepare(f.task.id, f.record.id);
    expect((await service.publish(f.task.id, f.record.id, true)).status).toBe("uncertain");
    await expect(service.prepare(f.task.id, f.record.id)).rejects.toThrow("reconcile");
    await service.close();
    await f.engine.close();
    reopened = await createFixtureEngine(f.root, () => new FixtureProvider());
    const recovered = new FinalizationService(reopened, async () => f.identity, f.transport, push);

    const result = await recovered.call("reconcile", {
      id: f.task.id,
      operation_id: f.record.id,
    });

    expect(result).toMatchObject({ status: "published", head: f.record.head });
    expect((await recovered.publish(f.task.id, f.record.id, true)).status).toBe("published");
    expect(push).toHaveBeenCalledOnce();
    await recovered.close();
  } finally {
    await service.close();
    await reopened?.close();
    await f.close();
  }
}, 30000);

it("rejects a concurrent writer, cancels a pending push and requires fresh confirmation before retry", async () => {
  const f = await committedFixture();

  const push = vi.fn(
    (request: Parameters<typeof execute>[0]) =>
      new Promise<Awaited<ReturnType<typeof execute>>>((_, reject) => {
        request.signal!.addEventListener(
          "abort",
          () => reject(new Error("Fixture cancelled before sending")),
          { once: true },
        );
      }),
  );

  const service = new FinalizationService(f.engine, async () => f.identity, f.transport, push);
  try {
    await service.prepare(f.task.id, f.record.id);
    const pending = service.publish(f.task.id, f.record.id, true);
    await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());

    expect(f.engine.cleanupBlockers(f.task.id)).toMatchObject([
      { id: `git:${f.task.id}`, task_id: f.task.id },
    ]);

    expect(f.engine.cleanupBlockers(f.task.id)).toHaveLength(1);
    expect(() => f.engine.acquireTerminal(f.task.id)).toThrow("Wait");

    await expect(async () => service.prepare(f.task.id, f.record.id)).rejects.toThrow(
      "already running",
    );

    await service.call("cancel", { id: f.task.id });
    expect((await pending).status).toBe("not_published");
    expect(f.engine.isActive(f.task.id)).toBe(false);

    await expect(service.publish(f.task.id, f.record.id, true)).rejects.toThrow(
      "explicitly confirm",
    );
  } finally {
    await service.close();
    await f.close();
  }
}, 30000);

it("keeps typed presets local and makes repeated selection requests idempotent", async () => {
  const f = await finalizationFixture();
  try {
    const sourceIndex = await readFile(join(f.repo.path, ".git", "index"));

    const preset = {
      name: "Local only",
      commit_hooks: "skip",
      push: "none",
      remote: "origin",
      branch: f.task.branch_name,
    };

    await f.service.call("preset", { id: f.task.id, preset });
    expect((await f.service.inspect(f.task.id)).preset).toEqual(preset);

    await expect(
      f.service.call("preset", {
        id: f.task.id,
        preset: { ...preset, command: "git push --mirror" },
      }),
    ).rejects.toThrow();

    const request = {
      id: f.task.id,
      request_id: randomUUID(),
      expected_hash: f.task.final_review_hash!,
      paths: ["source.txt"],
      replace_selected_staged: false,
    };

    const first = await f.service.preview(request);
    expect((await f.service.preview(request)).id).toBe(first.id);

    await expect(f.service.preview({ ...request, paths: [] })).rejects.toThrow(
      "different selected files",
    );

    expect(f.service.store.list(f.task.id)).toHaveLength(1);
    expect(await readFile(join(f.repo.path, ".git", "index"))).toEqual(sourceIndex);
    expect(f.engine.db.all("SELECT id FROM ai_usage")).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30000);
