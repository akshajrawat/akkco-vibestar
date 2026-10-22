import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, subscribe, errorMessage } from "../api";
import type { WatchScan } from "../../../backend/issue-watch/contracts";
import type { SavedWatch, WatchDetail, ScanDetail } from "./types";

export const useIssueWatch = (
  enabled: boolean,
  initialWatchId?: string | null,
) => {
  const [watches, setWatches] = useState<SavedWatch[]>([]);
  const [watchId, setWatchId] = useState(
    initialWatchId ||
      localStorage.getItem("vibestar.issueWatch.selected") ||
      "",
  );
  const [archived, setArchived] = useState(false);
  const [detail, setDetail] = useState<WatchDetail | null>(null);
  const [history, setHistory] = useState<WatchScan[]>([]);
  const [scanId, setScanId] = useState("");
  const [scan, setScan] = useState<ScanDetail | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++sequence.current;
    try {
      const list = await rpc<SavedWatch[]>("issueWatch.list", {
        archived,
        limit: 100,
      });
      if (request !== sequence.current) return;
      setWatches(list);
      const selected = list.find((watch) => watch.id === watchId);
      if (!selected) {
        setWatchId(list[0]?.id || "");
        setDetail(null);
        setHistory([]);
        setScan(null);
        return;
      }
      if (selected.error) {
        setError(selected.error);
        setDetail(null);
        setScan(null);
        return;
      }
      const [nextDetail, nextHistory] = await Promise.all([
        rpc<WatchDetail>("issueWatch.detail", { watch_id: selected.id }),
        rpc<WatchScan[]>("issueWatch.scanHistory", {
          watch_id: selected.id,
          limit: 50,
        }),
      ]);
      if (request !== sequence.current) return;
      setDetail(nextDetail);
      setHistory(nextHistory);
      const selectedScan =
        nextHistory.find((attempt) => attempt.id === scanId) || nextHistory[0];
      if (selectedScan) {
        const nextScan = await rpc<ScanDetail>("issueWatch.scanDetail", {
          watch_id: selected.id,
          scan_id: selectedScan.id,
        });
        if (request !== sequence.current) return;
        setScan(nextScan);
      } else setScan(null);
      setError("");
    } catch (e) {
      if (request === sequence.current) setError(errorMessage(e));
    }
  }, [enabled, archived, watchId, scanId]);
  useEffect(() => {
    if (initialWatchId) {
      setWatchId(initialWatchId);
      setScanId("");
    }
  }, [initialWatchId]);
  useEffect(() => {
    if (watchId) localStorage.setItem("vibestar.issueWatch.selected", watchId);
  }, [watchId]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const subscription = subscribe((event) => {
      if (
        (event.event.startsWith("issue-watch.") ||
          event.event === "utility.event" ||
          event.event === "usage.changed") &&
        !timer
      )
        timer = setTimeout(() => {
          timer = undefined;
          if (!disposed) void refresh();
        }, 200);
    });
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      sequence.current++;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", focus);
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, [enabled, refresh]);
  const select = (id: string) => {
    sequence.current++;
    setWatchId(id);
    setScanId("");
    setDetail(null);
    setScan(null);
  };
  return {
    watches,
    watchId,
    select,
    detail,
    history,
    scan,
    scanId,
    setScanId,
    archived,
    setArchived,
    error,
    setError,
    refresh,
  };
};
