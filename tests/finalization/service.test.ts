import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FinalizationService } from "../../backend/finalization/service";
import { createExactCommit } from "../../backend/workspace/commit-message";
import { checked, execute } from "../../backend/execution/runtime/process";
import { createFixtureEngine, FixtureProvider } from "../helpers/fixtures";

import { finalizationFixture as fixture } from "./fixtures";

it("rejects cross-task request collisions and mismatched saved owners without rewriting the journal", async () => {
  const f = await fixture();
  try {
    const record = await f.preview();
    const other = {
      ...f.task,
      id: randomUUID(),
      worktree_path: "",
      branch_name: "",
      branch_owned: false,
      status: "cancelled" as const,
    };
    f.engine.db.saveTask(other);
    const original = f.engine.db.all<{ data: string }>(
      "SELECT data FROM git_finalizations WHERE id=?",
      record.id,
    )[0].data;
    expect(() => f.service.store.save({ ...record, task_id: other.id })).toThrow("different task");
    expect(
      f.engine.db.all<{ data: string }>(
        "SELECT data FROM git_finalizations WHERE id=?",
        record.id,
      )[0].data,
    ).toBe(original);
    const invalid = JSON.stringify({ ...record, task_id: other.id });
    f.engine.db.run("UPDATE git_finalizations SET data=? WHERE id=?", invalid, record.id);
    expect(() => f.service.store.get(f.task.id, record.id)).toThrow();
    await expect(f.service.publish(f.task.id, record.id, true)).rejects.toThrow();
    expect(
      f.engine.db.all<{ data: string }>(
        "SELECT data FROM git_finalizations WHERE id=?",
        record.id,
      )[0].data,
    ).toBe(invalid);
    expect(f.engine.db.records.diagnostics().some((item) => item.record_id === record.id)).toBe(
      true,
    );
  } finally {
    await f.close();
  }
}, 30000);

it("shares provider execution capacity and reports one cancellable Git activity", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(() => new FixtureProvider(() => gate));
  try {
    f.engine.db.saveSettings({ ...f.engine.db.settings(), concurrency: 1 });
    await writeFile(join(f.task.worktree_path, "extra.txt"), "excluded fixture change\n");
    const record = await f.preview();
    const running = f.engine.reviewFinalization(
      f.engine.db.task(f.task.id),
      "Explicit fixture review",
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(f.engine.isExecuting(`git-review:${f.task.id}`)).toBe(true));
    await expect(f.service.review(f.task.id, record.id)).rejects.toThrow("execution slots");
    release();
    await running;
    const reviewed = await f.service.review(f.task.id, record.id);
    expect(reviewed.review?.approval).toBe("approved");
    expect(f.engine.cleanupBlockers(f.task.id)).toEqual([]);
  } finally {
    release();
    await f.close();
  }
}, 30000);

it("pages real saved output without exposing internal index snapshots to the renderer", async () => {
  const f = await fixture();
  try {
    const record = await f.preview();
    for (let index = 0; index < 250; index++)
      f.service.store.event(record, "Fixture output", `line ${index}`);
    const result = (await f.service.call("output", {
      id: f.task.id,
      operation_id: record.id,
    })) as {
      record: Record<string, unknown>;
      events: { id: number; output: string }[];
      events_older: boolean;
    };
    expect(result.events).toHaveLength(200);
    expect(result.events_older).toBe(true);
    expect(result.events.at(-1)?.output).toBe("line 249");
    expect(result.record).not.toHaveProperty("source_index");
    expect(result.record).not.toHaveProperty("projected_index");
    const earlier = (await f.service.call("output", {
      id: f.task.id,
      operation_id: record.id,
      before: result.events[0].id,
    })) as typeof result;
    expect(earlier.events_older).toBe(false);
    expect(earlier.events.some((event) => event.output === "line 0")).toBe(true);
    f.service.store.event(record, "Fixture large output", "x".repeat(70000));
    expect(f.service.store.events(record.id).at(-1)?.output).toContain("64 KiB event limit");
    f.service.store.event(record, "Fixture UTF-8 output", "🛰️".repeat(30000));
    expect(f.service.store.events(record.id).at(-1)?.output).not.toContain("\ufffd");
  } finally {
    await f.close();
  }
}, 30000);

it("keeps saved diagnostics accessible when the owned preview is unavailable", async () => {
  const f = await fixture();
  try {
    const record = await f.preview();
    f.service.store.event(record, "Saved diagnostic", "Preserved history", 2);
    const moved = `${record.preview_path}-temporarily-moved`;
    await rename(record.preview_path, moved);
    try {
      const detail = (await f.service.call("detail", {
        id: f.task.id,
        operation_id: record.id,
      })) as {
        record: { id: string };
        events: { output: string; exit_code: number | null }[];
        diff_error?: string;
      };
      expect(detail.record.id).toBe(record.id);
      expect(detail.diff_error).toBeTruthy();
      expect(detail.events.at(-1)).toMatchObject({
        output: "Preserved history",
        exit_code: 2,
      });
      await expect(f.service.approve(f.task.id, record.id)).rejects.toThrow();
    } finally {
      await rename(moved, record.preview_path);
    }
  } finally {
    await f.close();
  }
}, 30000);

it("commits literal new paths, staged renames and staged deletions without broad staging", async () => {
  const f = await fixture();
  try {
    const cwd = f.task.worktree_path;
    await rename(join(cwd, "rename.txt"), join(cwd, "renamed.txt"));
    await rm(join(cwd, "deleted.txt"));
    await checked("git", ["add", "--all", "--", "rename.txt", "renamed.txt", "deleted.txt"], cwd);
    const literal = ":[literal]*.txt";
    await writeFile(join(cwd, literal), "Literal filename content\n");
    const state = await f.service.inspect(f.task.id);
    expect(
      state.files.some((file) => file.path === "renamed.txt" && file.old_path === "rename.txt"),
    ).toBe(true);
    const record = await f.preview(["source.txt", "renamed.txt", "deleted.txt", literal], true);
    await f.service.review(f.task.id, record.id);
    await f.service.approve(f.task.id, record.id);
    const commit = await f.service.commit(
      f.task.id,
      record.id,
      "Explicit rename, deletion and literal path",
      true,
    );
    expect(await checked("git", ["show", `${commit.head}:${literal}`], cwd)).toBe(
      "Literal filename content",
    );
    expect(await checked("git", ["show", `${commit.head}:renamed.txt`], cwd)).toBe("rename me");
    expect(
      await checked(
        "git",
        ["ls-tree", "--name-only", commit.head!, "--", "rename.txt", "deleted.txt"],
        cwd,
      ),
    ).toBe("");
    expect(await checked("git", ["diff", "--cached", "--name-only"], cwd)).toBe("");
  } finally {
    await f.close();
  }
}, 30000);

it("keeps a subset blocked when the reviewer approves without fresh required command evidence", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.task.worktree_path, "check.js"), "const value = 1; void value;\n");
    const command = ["node", "--check", "check.js"];
    expect((await f.engine.runCommand(f.task.id, command)).code).toBe(0);
    const report = f.engine.db.artifact(f.task.id, 3);
    f.engine.db.run(
      "UPDATE task_artifacts SET content=? WHERE task_id=? AND stage=3",
      JSON.stringify({
        ...report,
        verification: [
          {
            name: "Node syntax",
            command: JSON.stringify(command),
            kind: "check",
            outcome: "passed",
            required: true,
            detail: "Observed fixture syntax check",
            prerequisite: null,
          },
        ],
      }),
      f.task.id,
    );
    const record = await f.preview(["source.txt", "check.js"]);
    const reviewed = await f.service.review(f.task.id, record.id);
    expect(reviewed.review?.approval).toBe("approved");
    expect(reviewed.verification_gap).toContain("Node syntax");
    await expect(f.service.approve(f.task.id, record.id)).rejects.toThrow(
      "Verification incomplete",
    );
    expect(f.service.store.get(f.task.id, record.id).approved_at).toBeNull();
  } finally {
    await f.close();
  }
}, 30000);

it("removes only the unchanged owned preview and its journal while preserving task contents", async () => {
  const f = await fixture();
  try {
    const record = await f.preview();
    const index = await readFile(
      await checked("git", ["rev-parse", "--git-path", "index"], f.task.worktree_path),
    );
    await expect(
      f.service.call("remove", { id: f.task.id, operation_id: record.id }),
    ).rejects.toThrow();
    await f.service.call("remove", {
      id: f.task.id,
      operation_id: record.id,
      confirmed: true,
    });
    expect(f.service.store.list(f.task.id)).toHaveLength(0);
    await expect(readFile(join(record.preview_path, "source.txt"))).rejects.toThrow();
    expect(
      await readFile(
        await checked("git", ["rev-parse", "--git-path", "index"], f.task.worktree_path),
      ),
    ).toEqual(index);
    expect(await readFile(join(f.task.worktree_path, "source.txt"), "utf8")).toBe(
      "independently reviewed change\n",
    );
  } finally {
    await f.close();
  }
}, 30000);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "commits exact selected content and publishes a new branch (skip commit %s, push %s)",
  async (commitSkip, pushSkip) => {
    const f = await fixture();
    try {
      const originalIndex = await readFile(join(f.repo.path, ".git", "index"));
      const originalSource = await readFile(join(f.repo.path, "source.txt"));
      const record = await f.preview();
      expect(record.status).toBe("reviewed");
      await expect(f.service.commit(f.task.id, record.id, "message", commitSkip)).rejects.toThrow(
        "Manually approve",
      );
      await f.service.approve(f.task.id, record.id);
      const message = commitSkip
        ? "  Exact title  \n\n# literal comment\nUnicode ✓  "
        : "Exact title without final newline";
      const committed = await f.service.commit(f.task.id, record.id, message, commitSkip);
      const object = await execute({
        program: "git",
        args: ["cat-file", "commit", committed.head!],
        cwd: f.task.worktree_path,
      });
      expect(object.stdout.slice(object.stdout.indexOf("\n\n") + 2)).toBe(message);
      expect(
        await checked("git", ["show", `${committed.head}:source.txt`], f.task.worktree_path),
      ).toBe("independently reviewed change");
      expect(await f.service.commit(f.task.id, record.id, message, commitSkip)).toMatchObject({
        head: committed.head,
      });
      await expect(
        f.service.call("publish", {
          id: f.task.id,
          operation_id: record.id,
          skip_hooks: pushSkip,
        }),
      ).rejects.toThrow();
      const prepared = await f.service.prepare(f.task.id, record.id);
      expect(prepared.destination).toMatchObject({
        repository: "contributor/fixture",
        upstream: "fixture/fixture",
        branch: f.task.branch_name,
        expected_remote: "0".repeat(40),
      });
      const result = await f.service.publish(f.task.id, record.id, pushSkip);
      expect(result.status).toBe("published");
      expect(await checked("git", ["rev-parse", `refs/heads/${f.task.branch_name}`], f.fork)).toBe(
        committed.head,
      );
      expect((await f.service.publish(f.task.id, record.id, pushSkip)).status).toBe("published");
      expect(await readFile(join(f.repo.path, ".git", "index"))).toEqual(originalIndex);
      expect(await readFile(join(f.repo.path, "source.txt"))).toEqual(originalSource);
      expect(f.engine.db.all("SELECT id FROM ai_usage")).toEqual([]);
      expect(
        f.service.store.events(record.id).some((event) => event.phase === "Push verified"),
      ).toBe(true);
    } finally {
      await f.close();
    }
  },
  30000,
);

it("keeps unsafe and unrelated files out, freshly reviews a subset and preserves excluded staged content", async () => {
  const f = await fixture();
  try {
    const cwd = f.task.worktree_path;
    await writeFile(join(cwd, "deleted.txt"), "unrelated staged update\n");
    await checked("git", ["add", "--", "deleted.txt"], cwd);
    await writeFile(join(cwd, ".env"), "FAKE=secret\n");
    await mkdir(join(cwd, ".codex"));
    await writeFile(join(cwd, ".codex", "profile.json"), '{"fixture":true}\n');
    await writeFile(join(cwd, "innocent.txt"), "-----BEGIN PRIVATE KEY-----\nfixture\n");
    const originalIndex = await readFile(
      await checked("git", ["rev-parse", "--git-path", "index"], cwd),
    );
    const inspected = await f.service.inspect(f.task.id);
    expect(inspected.files.filter((file) => file.excluded).map((file) => file.path)).toEqual(
      expect.arrayContaining([".env", "innocent.txt", ".codex/profile.json"]),
    );
    await expect(f.preview(["source.txt", ".env"])).rejects.toThrow("inspected");
    const record = await f.preview();
    expect(record.status).toBe("draft");
    await expect(f.service.approve(f.task.id, record.id)).rejects.toThrow("independent review");
    expect(await readFile(join(record.preview_path, "deleted.txt"), "utf8")).toBe("delete me\n");
    await expect(readFile(join(record.preview_path, ".env"))).rejects.toThrow();
    const reviewed = await f.service.review(f.task.id, record.id);
    expect(reviewed.review_source).toBe("selection");
    expect(await readFile(await checked("git", ["rev-parse", "--git-path", "index"], cwd))).toEqual(
      originalIndex,
    );
    await f.service.approve(f.task.id, record.id);
    const committed = await f.service.commit(f.task.id, record.id, "Only the selected fix", true);
    expect(
      await checked("git", ["diff", "--name-only", `${record.parent}..${committed.head}`], cwd),
    ).toBe("source.txt");
    expect(await checked("git", ["show", ":deleted.txt"], cwd)).toBe("unrelated staged update");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("FAKE=secret\n");
    expect(
      f.engine.db.all<{ purpose: string }>(
        "SELECT purpose FROM agent_runs WHERE task_id=? AND purpose='git-finalization-review'",
        f.task.id,
      ),
    ).toEqual([{ purpose: "git-finalization-review" }]);
    expect(
      f.engine.db.all("SELECT id FROM task_artifacts WHERE task_id=? AND stage=5", f.task.id),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);

it("requires an explicit decision for selected staged hunks and invalidates changed review content", async () => {
  const f = await fixture();
  try {
    await checked("git", ["add", "--", "source.txt"], f.task.worktree_path);
    await writeFile(join(f.task.worktree_path, "source.txt"), "new unstaged content\n");
    await expect(f.preview()).rejects.toThrow("Explicitly confirm");
    const record = await f.preview(["source.txt"], true);
    expect(record.status).toBe("draft");
    await f.service.review(f.task.id, record.id);
    await f.service.approve(f.task.id, record.id);
    await writeFile(join(f.task.worktree_path, "source.txt"), "changed after approval\n");
    await expect(f.service.commit(f.task.id, record.id, "Blocked", true)).rejects.toThrow(
      "changed",
    );
    expect(await checked("git", ["show", ":source.txt"], f.task.worktree_path)).toBe(
      "independently reviewed change",
    );
  } finally {
    await f.close();
  }
}, 30000);

it("reconciles an interrupted local commit read-only and resumes only with explicit confirmation", async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof createFixtureEngine>> | undefined;
  try {
    const record = await f.preview();
    await f.service.approve(f.task.id, record.id);
    const approved = f.service.store.get(f.task.id, record.id);
    approved.message = "Preserved interrupted message";
    approved.head = await createExactCommit(
      approved.preview_path,
      approved.tree!,
      approved.parent,
      approved.message,
      new AbortController().signal,
    );
    approved.status = "committing";
    f.service.store.save(approved);
    await f.service.close();
    await f.engine.close();
    reopened = await createFixtureEngine(f.root, () => new FixtureProvider());
    const service = new FinalizationService(reopened, async () => f.identity, f.transport);
    expect(service.store.get(f.task.id, record.id).status).toBe("interrupted");
    await service.call("reconcile", { id: f.task.id, operation_id: record.id });
    expect(await checked("git", ["rev-parse", "HEAD"], f.task.worktree_path)).toBe(approved.parent);
    await expect(
      service.call("resumeCommit", { id: f.task.id, operation_id: record.id }),
    ).rejects.toThrow();
    const resumed = await service.call("resumeCommit", {
      id: f.task.id,
      operation_id: record.id,
      confirmed: true,
    });
    expect(resumed).toMatchObject({ status: "committed", head: approved.head });
    expect(await checked("git", ["rev-parse", "HEAD"], f.task.worktree_path)).toBe(approved.head);
    await service.close();
  } finally {
    await reopened?.close();
    await f.close();
  }
}, 30000);
