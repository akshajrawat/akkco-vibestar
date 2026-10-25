import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Rpc } from "../../backend/rpc";
import { taskVerification } from "../../backend/execution/task-verification";
import { Database } from "../../backend/storage/database";
import { finalizationFixture } from "../finalization/fixtures";

it("applies an explicit policy and rechecks an accepted review without losing its approval, starting a model or bypassing required tests", async () => {
  const fixture = await finalizationFixture(() => {
    throw new Error("Policy recheck must not invoke a model");
  });
  const { engine, task, service } = fixture;
  try {
    const artifact = engine.db.all<{ id: string; content: string }>(
      "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=3",
      task.id,
    )[0];
    const report = JSON.parse(artifact.content);
    report.verification = [
      {
        name: "Browser setup",
        command: null,
        kind: "setup",
        outcome: "blocked",
        required: true,
        detail: "Browser tooling unavailable",
        prerequisite: null,
      },
      {
        name: "Browser rendering",
        command: null,
        kind: "check",
        outcome: "not_run",
        required: true,
        detail: "Manual browser check did not run",
        prerequisite: "Browser setup",
      },
    ];
    engine.db.run(
      "UPDATE task_artifacts SET content=? WHERE id=?",
      JSON.stringify(report),
      artifact.id,
    );
    engine.db.saveTask({
      ...engine.db.task(task.id),
      status: "reviewed_with_gaps",
      final_review_verdict: "code_approved_incomplete",
    });
    const original = engine.db.detail(task.id);
    const fingerprint = await engine.git.fingerprint(engine.db.task(task.id));
    expect(taskVerification(engine.db, task.id).canReview).toBe(false);
    const rpc = new Rpc(engine);
    await expect(
      rpc.call("task.verification.policy", {
        id: task.id,
        policy: "repository",
      }),
    ).rejects.toThrow();
    const updated = await rpc.call("task.verification.policy", {
      id: task.id,
      policy: "repository",
      confirmed: true,
    });
    expect(updated).toMatchObject({
      stage: 6,
      status: "ready_for_review",
      verification_policy: "repository",
      final_review_verdict: "verified",
      final_review_hash: fingerprint,
    });
    expect(taskVerification(engine.db, task.id)).toMatchObject({
      canReview: true,
      blockers: [],
    });
    expect(engine.db.detail(task.id).runs).toEqual(original.runs);
    expect(engine.db.detail(task.id).artifacts).toEqual(original.artifacts);
    expect(await engine.git.fingerprint(engine.db.task(task.id))).toBe(
      fingerprint,
    );
    await expect(service.inspect(task.id)).resolves.toHaveProperty("files");
    const reopened = await Database.open(
      join(engine.root, "state", "vibestar.sqlite"),
    );
    try {
      expect(reopened.task(task.id).verification_policy).toBe("repository");
    } finally {
      reopened.close();
    }
    await rpc.call("task.verification.policy", {
      id: task.id,
      policy: "extended_browser",
      confirmed: true,
    });
    expect(engine.db.task(task.id).status).toBe("reviewed_with_gaps");
    await expect(fixture.preview()).rejects.toThrow();
    await rpc.call("task.verification.policy", {
      id: task.id,
      policy: "repository",
      confirmed: true,
    });
    const reviewArtifact = engine.db.all<{ id: string; content: string }>(
      "SELECT id,content FROM task_artifacts WHERE task_id=? AND stage=5",
      task.id,
    )[0];
    const review = JSON.parse(reviewArtifact.content);
    review.verification = [{ ...report.verification[1], scope: "repository" }];
    engine.db.run(
      "UPDATE task_artifacts SET content=? WHERE id=?",
      JSON.stringify(review),
      reviewArtifact.id,
    );
    expect(
      taskVerification(engine.db, task.id).checks.find(
        (check) => check.name === "Browser rendering",
      ),
    ).toMatchObject({ scope: "repository", required: true });
    expect(taskVerification(engine.db, task.id).canReview).toBe(false);
    engine.db.run(
      "UPDATE task_artifacts SET content=? WHERE id=?",
      reviewArtifact.content,
      reviewArtifact.id,
    );
    engine.db.run(
      "INSERT INTO test_runs(id,task_id,command,status,started_at,ended_at,exit_code,stdout) VALUES('actual-failure',?,'npm test','failed',?,?,1,'AssertionError: wrong result')",
      task.id,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await engine.recheckEvidence(task.id);
    expect(taskVerification(engine.db, task.id).outcome).toBe("failed");
    expect(engine.db.task(task.id).final_review_verdict).toBe(
      "changes_requested",
    );
    await expect(fixture.preview()).rejects.toThrow();
    const path = join(task.worktree_path, "source.txt");
    await writeFile(
      path,
      (await readFile(path, "utf8")) + "Changed after review\n",
    );
    await expect(engine.recheckEvidence(task.id)).rejects.toMatchObject({
      kind: "stale_review",
    });
  } finally {
    await fixture.close();
  }
}, 30000);
