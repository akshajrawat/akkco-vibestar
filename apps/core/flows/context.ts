import { AdeError } from "../domain";
import type { Database } from "../storage/database";
import { ResolvedInputsSchema } from "./run-contracts";
import { FlowRunStore } from "./run-store";
import type { FlowNode } from "./contracts";
import type { NodeAttempt } from "./run-contracts";

const verificationContent = (db: Database, taskId: string, source: NodeAttempt) => {
  const checks = source.agent_run_id
    ? db.all(
        "SELECT id,command,status,exit_code,stdout,stderr,output_truncated FROM test_runs WHERE run_id=? AND task_id=? ORDER BY rowid",
        source.agent_run_id,
        taskId,
      )
    : source.command_run_id
      ? db.all(
          "SELECT id,command,status,exit_code,stdout,stderr,output_truncated FROM test_runs WHERE id=? AND task_id=?",
          source.command_run_id,
          taskId,
        )
      : [];

  return JSON.stringify({
    verification: source.verification,
    observed_commands: checks,
    provider_report: source.agent_run_id ? source.output : null,
    note: "Observed command evidence is separate from provider reports. Missing, failed or truncated evidence is not passing coverage.",
  });
};

/** Only selected bindings enter a node; references resolve through their persisted owners. */
export const resolveNodeInputs = (
  db: Database,
  runs: FlowRunStore,
  runId: string,
  nodeId: string,
) => {
  const run = runs.run(runId);

  const node = runs.definition(run.id).nodes.find((entry) => entry.id === nodeId);

  if (!node) throw new AdeError("isolation", "The input target is outside this flow revision.");
  return resolveBoundInputs(db, run.task_id, run.snapshot.goal, node, runs.results(runId));
};

/** Continuation previews resolve the same bounded, owner-checked inputs before creating a run. */
export const resolveBoundInputs = (
  db: Database,
  taskId: string,
  goal: string,
  node: FlowNode,
  attempts: NodeAttempt[],
) => {
  const task = db.task(taskId);

  const resolved = node.inputs.map((binding) => {
    let content: string;
    if (binding.kind === "task-goal") content = goal;
    else if (binding.kind === "task-brief")
      content = JSON.stringify({
        scope_mode: task.scope_mode,
        claimed_scope: task.claimed_scope,
        notes: task.notes,
        reviewed_summary: task.workflow_start?.summary || null,
      });
    else if (binding.kind === "repository") {
      if (!task.repo_id)
        throw new AdeError(
          "context_unavailable",
          "This node selected repository context, but the task has no repository.",
        );
      const repository = db.repository(task.repo_id);

      content = JSON.stringify({
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        url: repository.upstream_url,
        base_branch: task.base_branch,
        base_commit: task.base_commit_sha,
        branch: task.branch_name,
        workspace: task.worktree_path,
      });
    } else if (binding.kind === "issue") {
      if (!task.issue_url || !task.issue_number)
        throw new AdeError(
          "context_unavailable",
          "This node selected issue context, but the task has no issue.",
        );

      content = JSON.stringify({
        url: task.issue_url,
        number: task.issue_number,
        scope: task.scope_mode,
        claimed_scope: task.claimed_scope,
        issue: task.issue,
      });
    } else if (binding.kind === "message") {
      const message = db.all<{ role: string; content: string }>(
        "SELECT role,content FROM task_messages WHERE id=? AND task_id=?",
        binding.message_id,
        taskId,
      )[0];

      if (!message)
        throw new AdeError("isolation", "Selected conversation messages must belong to this task.");
      content = JSON.stringify(message);
    } else if (binding.kind === "command-evidence") {
      if (
        binding.run_id !== null &&
        !db.all("SELECT id FROM agent_runs WHERE id=? AND task_id=?", binding.run_id, taskId).length
      )
        throw new AdeError("isolation", "Selected command evidence must belong to this task.");

      content = JSON.stringify({
        observed_commands: db.all(
          "SELECT id,command,status,exit_code,stdout,stderr,output_truncated FROM test_runs WHERE run_id IS ? AND task_id=? ORDER BY rowid",
          binding.run_id,
          taskId,
        ),
        note: "These are observed command records. Provider-reported checks and missing evidence are separate.",
      });
    } else if (binding.kind === "artifact") {
      const artifact = db.all<{ task_id: string; content: string }>(
        "SELECT task_id,content FROM task_artifacts WHERE id=? AND task_id=?",
        binding.artifact_id,
        taskId,
      )[0];

      if (!artifact || artifact.task_id !== taskId)
        throw new AdeError("isolation", "Selected artifacts must belong to this task.");
      content = artifact.content;
    } else if (binding.kind === "attempt-output" || binding.kind === "attempt-verification") {
      const runs = new FlowRunStore(db);
      const source = runs.attempt(binding.attempt_id);
      if (runs.run(source.run_id).task_id !== taskId)
        throw new AdeError("isolation", "Selected retained results must belong to this task.");
      if (source.status !== "completed")
        throw new AdeError(
          "context_unavailable",
          "Select a completed retained result; incomplete attempts are not conversation handoffs.",
        );
      if (binding.kind === "attempt-output") {
        if (source.output === null)
          throw new AdeError("context_unavailable", "The selected attempt has no retained output.");
        content = source.output;
      } else content = verificationContent(db, taskId, source);
    } else {
      const source = attempts.filter((attempt) => attempt.node_id === binding.node_id).at(-1);
      if (!source || source.status !== "completed")
        throw new AdeError(
          "dependencies",
          "Selected predecessor context requires a completed result.",
        );
      if (binding.kind === "output") {
        if (source.output === null)
          throw new AdeError(
            "context_unavailable",
            "The selected predecessor has no retained output.",
          );
        content = source.output;
      } else {
        content = verificationContent(db, taskId, source);
      }
    }

    return { binding, content };
  });

  const result = ResolvedInputsSchema.safeParse(resolved);
  if (!result.success)
    throw new AdeError(
      "context_limit",
      "Selected context exceeds 128 KiB. Select fewer inputs or artifacts; no context was silently truncated.",
    );
  return result.data;
};
