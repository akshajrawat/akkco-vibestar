import { useEffect, useRef } from "react";

import type { Snapshot } from "../lib/types";
import { notifications } from "../lib/notifications";

/** Observe saved status transitions; notifications never start or resume execution. */
export const useTaskNotifications = (snapshot: Snapshot | null, open: (id: string) => void) => {
  const previous = useRef(new Map<string, string>());

  useEffect(() => {
    if (!snapshot) return;
    const next = new Map<string, string>();
    for (const task of snapshot.tasks) {
      const status = snapshot.flow_states?.[task.id]?.status || task.status;
      next.set(task.id, status);
      if (previous.current.get(task.id) === status) continue;
      const id = `task:${task.id}`;
      notifications.dismiss(id);
      const action = { label: "Open task", run: () => open(task.id) };
      const label = task.goal || task.issue?.title || "Task";
      if (["waiting", "awaiting_approval"].includes(status))
        notifications.information(`${label} needs your input`, { id, essential: true, action });
      else if (previous.current.has(task.id)) {
        if (["failed", "needs_recovery", "blocked"].includes(status))
          notifications.error(`${label}: ${task.error || "Task needs attention"}`, { id, action });
        else if (["completed", "ready_for_review"].includes(status))
          notifications.success(`${label} completed`, { id });
      }
    }

    for (const id of previous.current.keys())
      if (!next.has(id)) notifications.dismiss(`task:${id}`);

    previous.current = next;
  }, [snapshot, open]);
};
