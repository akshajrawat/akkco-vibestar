import type { Database } from "../storage/database";
import type { Task } from "../domain";

export const continuationStage = (db: Database, task: Task) => {
  if (!task.worktree_path) return 0;
  const stages = db
    .all<{ stage: number }>(
      "SELECT DISTINCT stage FROM task_artifacts WHERE task_id=?",
      task.id,
    )
    .map((r) => r.stage);
  if (!stages.includes(1)) return 1;
  if (!stages.includes(2)) return 2;
  return 3;
};
