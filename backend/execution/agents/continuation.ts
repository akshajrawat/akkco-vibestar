import type { Database } from "../../storage/database";
import type { Task } from "../../domain";

export const continuationStage = (db: Database, task: Task) => {
  if (!task.worktree_path) return 0;
  if (task.approval_gate === "antigravity_plan") return 1;
  if (task.approval_gate === "codex_plan") return 2;
  const stages = db
    .all<{ stage: number }>(
      "SELECT DISTINCT stage FROM task_artifacts WHERE task_id=? AND kind='plan'",
      task.id,
    )
    .map((r) => r.stage);
  if (!stages.includes(1)) return 1;
  if (!stages.includes(2)) return 2;
  return 3;
};
