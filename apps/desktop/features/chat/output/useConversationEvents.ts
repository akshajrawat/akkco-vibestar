import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentEvent } from "../../../lib/types";
import { rpc, errorMessage } from "../../../lib/api";

/** Preserve actual message deltas across bounded snapshots, and read missing history after refresh or a gap. */
export const useConversationEvents = (
  id: string,
  owner: "task" | "repair",
  events: AgentEvent[],
  onError: (message: string) => void,
) => {
  const scope = `${owner}:${id}`;

  const cache = useRef({
    scope,
    messages: new Map<number, AgentEvent>(),
    complete: new Set<string>(),
    last: 0,
    generation: 0,
  });

  const [history, setHistory] = useState({ scope, events: [] as AgentEvent[] });
  const error = useRef(onError);
  error.current = onError;
  const boundary = useRef(0);
  boundary.current = events.at(-1)?.id || 0;

  const projection = useMemo(() => {
    const state = cache.current;
    if (state.scope !== scope) {
      state.scope = scope;
      state.messages.clear();
      state.complete.clear();
      state.last = 0;
      state.generation++;
    }

    const visibleRuns = new Set(events.map((event) => event.run_id));
    for (const [key, event] of state.messages)
      if (!visibleRuns.has(event.run_id)) state.messages.delete(key);
    for (const runId of state.complete) if (!visibleRuns.has(runId)) state.complete.delete(runId);
    if (events.length >= 2000 && state.last && events[0].id > state.last) {
      state.complete.clear();
      state.generation++;
    }

    state.last = events.at(-1)?.id || state.last;
    if (events.length < 2000) for (const runId of visibleRuns) state.complete.add(runId);
    for (const event of events) if (event.kind === "run.started") state.complete.add(event.run_id);
    const recovered = history.scope === scope ? history.events : [];
    for (const event of [...recovered, ...events]) {
      if (
        event.kind === "message" &&
        visibleRuns.has(event.run_id) &&
        state.complete.has(event.run_id)
      )
        state.messages.set(event.id, event);
    }

    const rows = [
      ...events.filter((event) => event.kind !== "message"),
      ...state.messages.values(),
    ];

    const runs = [
      ...new Set(events.filter((event) => event.kind === "message").map((event) => event.run_id)),
    ].sort();

    return { rows, runKey: JSON.stringify(runs), generation: state.generation };
  }, [events, history, scope]);

  useEffect(() => {
    let alive = true;
    const generation = projection.generation;
    const runs = JSON.parse(projection.runKey) as string[];

    const hydrate = async () => {
      const recovered: AgentEvent[] = [];
      try {
        for (const runId of runs) {
          if (cache.current.complete.has(runId)) continue;
          let after = 0;
          while (alive && after < boundary.current) {
            const page = await rpc<{ events: AgentEvent[]; more: boolean }>(`${owner}.events`, {
              id,
              run_id: runId,
              after,
            });

            if (!alive || cache.current.generation !== generation) return;
            recovered.push(...page.events.filter((event) => event.kind === "message"));
            const last = page.events.at(-1)?.id;
            if (!last || !page.more) break;
            if (last <= after) throw new Error("Conversation history did not advance.");
            after = last;
          }

          if (!alive || cache.current.generation !== generation) return;
          cache.current.complete.add(runId);
        }

        if (alive && recovered.length) setHistory({ scope, events: recovered });
      } catch (reason) {
        if (alive) error.current(errorMessage(reason));
      }
    };

    // Existing paginated reads only: no provider action and no background retry timer.
    void hydrate();
    return () => {
      alive = false;
    };
  }, [id, owner, scope, projection.runKey, projection.generation]);

  return projection.rows;
};
