import { useEffect, useRef, useState } from "react";
import type { AgentEvent, Run } from "../../../lib/types";
import { rpc, errorMessage } from "../../../lib/api";

interface LogPage {
  text: string;
  truncated: boolean;
  start: number;
  end: number;
  size: number;
}
export const useAgentOutput = ({
  taskId,
  run,
  events,
  raw,
  stream,
  search,
  preparation,
  owner = "task",
  watchId,
  scanId,
}: {
  taskId: string;
  run?: Run;
  events: AgentEvent[];
  raw: boolean;
  stream: "stdout" | "stderr" | "events";
  search: string;
  preparation: boolean;
  owner?: "task" | "repair" | "issueWatch";
  watchId?: string;
  scanId?: string;
}) => {
  const [rows, setRows] = useState<AgentEvent[] | null>(null);
  const [log, setLog] = useState<LogPage>({
    text: "",
    truncated: false,
    start: 0,
    end: 0,
    size: 0,
  });
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useRef<(older?: boolean) => Promise<void>>(async () => {});
  const status = useRef(run?.status);
  status.current = run?.status;
  const runId = preparation ? null : run?.id || null;
  const file = (raw && stream !== "events") || preparation;
  useEffect(() => {
    if (!runId && !preparation) return;
    setRows(null);
    setLog({ text: "", truncated: false, start: 0, end: 0, size: 0 });
    setMore(false);
    setError("");
    let alive = true;
    let fetching = false;
    let initialized = false;
    let savedRows: AgentEvent[] = [];
    let oldest = Number.MAX_SAFE_INTEGER;
    let newest = 0;
    let savedLog: LogPage = {
      text: "",
      truncated: false,
      start: 0,
      end: 0,
      size: 0,
    };
    let previousStatus = status.current;
    const fetch = async (older = false) => {
      if (fetching) return;
      fetching = true;
      setLoading(true);
      let catchup = false;
      try {
        if (file) {
          const page = await rpc<LogPage>(`${owner}.logs`, {
            ...(owner === "issueWatch"
              ? { watch_id: watchId, scan_id: scanId }
              : { id: taskId, paged: true }),
            run_id: runId,
            stream: stream === "stderr" ? "stderr" : "stdout",
            search,
            ...(initialized
              ? search
                ? { after: savedLog.end }
                : older
                  ? { before: savedLog.start }
                  : { after: savedLog.end }
              : {}),
          });
          if (alive && page) {
            catchup = initialized && !older && !search && page.end < page.size;
            savedLog = !initialized
              ? page
              : {
                  ...page,
                  text: older && !search ? page.text + savedLog.text : savedLog.text + page.text,
                  start: older && !search ? page.start : savedLog.start,
                  end: older && !search ? savedLog.end : page.end,
                };
            setLog(savedLog);
            setMore(search ? page.truncated : savedLog.start > 0);
          }
        } else {
          const page = await rpc<{
            events: AgentEvent[];
            context?: AgentEvent[];
            more: boolean;
          }>(`${owner}.events`, {
            ...(owner === "issueWatch" ? { watch_id: watchId, scan_id: scanId } : { id: taskId }),
            run_id: runId,
            search,
            ...(initialized && newest ? (older ? { before: oldest } : { after: newest }) : {}),
          });
          if (alive && page) {
            catchup = initialized && !older && page.more;
            const byId = new Map(
              [...savedRows, ...page.events, ...(page.context || [])].map((e) => [e.id, e]),
            );
            if (page.events.length) {
              oldest = Math.min(oldest, page.events[0].id);
              newest = Math.max(newest, page.events.at(-1)!.id);
            }
            savedRows = [...byId.values()].sort((a, b) => a.id - b.id);
            setRows(savedRows);
            if (!initialized || older) setMore(page.more);
          }
        }
        initialized = true;
        if (alive) setError("");
      } catch (e) {
        if (alive) setError(errorMessage(e));
      } finally {
        fetching = false;
        if (alive) setLoading(false);
        if (alive && catchup) void fetch();
      }
    };
    load.current = fetch;
    const initial = setTimeout(() => void fetch(), search ? 250 : 0);
    const timer = setInterval(() => {
      if (status.current === "running" || previousStatus !== status.current) void fetch();
      previousStatus = status.current;
    }, 1000);
    return () => {
      alive = false;
      clearTimeout(initial);
      clearInterval(timer);
      load.current = async () => {};
    };
  }, [taskId, runId, preparation, file, stream, search, owner, watchId, scanId]);
  const byId = new Map(
    [
      ...(rows || []),
      ...(!search
        ? events.filter((e) => e.run_id === runId && (!rows || e.id > (rows.at(-1)?.id || 0)))
        : []),
    ].map((e) => [e.id, e]),
  );
  return {
    events: [...byId.values()].sort((a, b) => a.id - b.id),
    log,
    more,
    error,
    loading,
    loadMore: () => load.current(true),
    refresh: () => load.current(),
  };
};
