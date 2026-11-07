import { useEffect, useRef, useState } from "react";

import type { FlowWorkspace } from "../../../backend/flows/workspace";
import type { Detail, Snapshot, Task } from "../../lib/types";
import { rpc } from "../../lib/api";
import { flowTaskActivity, legacyTaskActivity, taskNavigationState } from "./taskNavigationState";
import type { TaskActivity } from "./taskNavigationState";

/** Read existing execution evidence without adding a polling loop or retaining full run histories. */
export const useTaskActivity = (
  tasks: Task[],
  flowStates: Snapshot["flow_states"],
  revision: number,
) => {
  const cache = useRef(new Map<string, { key: string; activity?: TaskActivity }>());
  const [activities, setActivities] = useState<Record<string, TaskActivity | undefined>>({});

  const requestKey = JSON.stringify(
    tasks
      .flatMap((task) => {
        const flow = flowStates?.[task.id];
        if (task.flow_id ? !flow?.run_id : task.status === "not_started") return [];
        const state = taskNavigationState(task, flow);
        return [
          {
            id: task.id,
            working: state.working,
            runId: flow?.run_id,
            key: JSON.stringify([
              task.updated_at,
              task.status,
              flow?.run_id,
              flow?.status,
              state.working ? revision : null,
            ]),
          },
        ];
      })
      .sort((a, b) => Number(b.working) - Number(a.working)),
  );

  useEffect(() => {
    let alive = true;
    const requests = JSON.parse(requestKey) as { id: string; runId?: string; key: string }[];
    const ids = new Set(requests.map((request) => request.id));
    for (const id of cache.current.keys()) if (!ids.has(id)) cache.current.delete(id);

    let next = 0;

    const read = async () => {
      while (alive && next < requests.length) {
        const request = requests[next++];
        if (cache.current.get(request.id)?.key === request.key) continue;

        let activity: TaskActivity | undefined;
        try {
          activity = request.runId
            ? flowTaskActivity(
                await rpc<FlowWorkspace>("flow.workspace", { task_id: request.id }),
                request.runId,
              )
            : legacyTaskActivity(await rpc<Detail>("task.detail", { id: request.id }));
        } catch {
          // Missing or unavailable history provides no reliable timing evidence.
        }

        if (!alive) return;
        if (activity) cache.current.set(request.id, { key: request.key, activity });
        else cache.current.delete(request.id);

        setActivities(
          Object.fromEntries([...cache.current].map(([id, entry]) => [id, entry.activity])),
        );
      }
    };

    // Bound history reads even when a workspace contains hundreds of saved tasks.
    void Promise.all(Array.from({ length: Math.min(4, requests.length) }, read));
    return () => {
      alive = false;
    };
  }, [requestKey, revision]);

  return activities;
};
