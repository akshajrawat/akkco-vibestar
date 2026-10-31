import type { Database } from "../../storage/database";
import type { Task } from "../../domain";
import { object } from "../providers/contracts";

/** The same user brief is sent to the provider and shown in the conversation. */
export const buildPrompt = (db: Database, task: Task) => {
  // Implementation receives the approved refinement verbatim, without a second brief.
  if (task.stage === 3) {
    const plan = JSON.stringify(db.artifact(task.id, 2), null, 2);

    const instructions = db.all<{ content: string }>(
      "SELECT content FROM task_messages WHERE task_id=? AND purpose='instruction' AND status='delivered' ORDER BY created_at,rowid",
      task.id,
    );

    const repair =
      task.continuation === "implementation"
        ? db.all<{ data: string }>(
            "SELECT data FROM task_activity WHERE task_id=? AND kind='verification_repair' ORDER BY id DESC LIMIT 1",
            task.id,
          )[0]
        : undefined;

    return [
      plan,
      ...instructions.map((message) => message.content),
      ...(repair ? [`Saved verification evidence:\n${repair.data}`] : []),
    ].join("\n\n");
  }

  const issue = task.issue;
  const comments = Array.isArray(issue.comments) ? issue.comments : [];

  const brief = [
    `This is the issue : ${issue.title || `Issue #${task.issue_number}`}`,
    task.issue_url,
    String(issue.body || "No description provided."),
    ...comments.map((entry) => {
      const comment = object(entry);
      return `Comment by ${object(comment.user).login || comment.author || "contributor"}${comment.html_url ? ` (${comment.html_url})` : ""}:\n${comment.body || ""}`;
    }),
    task.scope_mode === "whole_issue" ? "Scope: entire issue." : `Scope: ${task.claimed_scope}`,
    task.notes,
  ].filter(Boolean);

  const selected = task.workflow_start;
  if (selected?.summary) brief.push(selected.summary);
  for (const id of selected?.message_ids || []) {
    const message = db.all<{ content: string }>(
      "SELECT content FROM task_messages WHERE task_id=? AND id=? AND purpose='chat' AND status='chat_completed'",
      task.id,
      id,
    )[0];

    if (message) brief.push(message.content);
  }

  for (const message of db.all<{ content: string }>(
    "SELECT content FROM task_messages WHERE task_id=? AND purpose='instruction' AND status='delivered' ORDER BY created_at,rowid",
    task.id,
  ))
    brief.push(message.content);

  if (Array.isArray(issue.contextWarnings) && issue.contextWarnings.length)
    brief.push(`Context retrieval notes: ${issue.contextWarnings.join("\n")}`);

  if (task.stage === 1)
    return `${brief.join("\n\n")}\n\nRead it carefully, search recursively through any links or files you want to for that repository and create a detailed plan to solve this issue`;

  if (task.stage === 2)
    return `${brief.join("\n\n")}\n\nThis is the plan :\n${JSON.stringify(db.artifact(task.id, 1), null, 2)}\n\nRead the issue carefully, search recursively through relevant links and repository files, and refine this plan if needed. Correct missing requirements and assumptions. Make the refined plan self-contained for implementation: include the scope, repository conventions, exact applicable test, type, lint, formatting and stress checks, and prerequisites. Use installed tools; do not install or download dependencies, browsers or toolchains. Leave Git commits, pushes and GitHub writes for the user to perform manually. Do not edit files or run tests.`;

  return `${brief.join("\n\n")}\n\nMake sure branch ${task.branch_name} contains the complete working fix for this scope. Review the full diff and run the relevant tests, including a stress test once if needed and feasible with installed tools. Report actual results and any missing prerequisites honestly. Keep source and Git read-only. If changes are needed, explain the problems in your reply; do not fix them or start another implementation run.\n\nThen tell me my next steps in numbered points, including whether this repository asks me to claim the issue, share recordings, run a GitHub stress test, or raise a PR. Recommend remote actions for me to perform manually. Finish with a clear pass, changes requested, or blocked verdict.`;
};
