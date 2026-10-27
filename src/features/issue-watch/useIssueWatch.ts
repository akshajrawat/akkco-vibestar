import { useCallback, useEffect, useRef, useState } from "react";

import { rpc, subscribe, errorMessage } from "../../lib/api";
import type { WatchScan } from "../../../backend/issue-watch/contracts";
import type { SavedWatch, WatchDetail, ScanDetail } from "./types";

export const useIssueWatch = (enabled: boolean, initialWatchId?: string | null) => {
  const [watches, setWatches] = useState<SavedWatch[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [watchId, setWatchId] = useState(
    initialWatchId || localStorage.getItem("vibestar.issueWatch.selected") || "",
  );

  const [archived, setArchived] = useState(false);
  const [watchPages, setWatchPages] = useState(1);
  const [historyPages, setHistoryPages] = useState(1);
  const [moreWatches, setMoreWatches] = useState(false);
  const [moreHistory, setMoreHistory] = useState(false);
  const [detail, setDetail] = useState<WatchDetail | null>(null);
  const [history, setHistory] = useState<WatchScan[]>([]);
  const [scanId, setScanId] = useState("");
  const [scan, setScan] = useState<ScanDetail | null>(null);
  const [error, setError] = useState("");
  const sequence = useRef(0);

  const invalidate = useCallback(() => {
    sequence.current++;
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const request = ++sequence.current;
    try {
      const list: SavedWatch[] = [];
      let watchPage: SavedWatch[] = [];
      for (let index = 0; index < watchPages; index++) {
        watchPage = await rpc<SavedWatch[]>("issueWatch.list", {
          archived,
          limit: 100,
          ...(list.length ? { before: list[list.length - 1].id } : {}),
        });

        if (request !== sequence.current) return;
        list.push(...watchPage);
        if (watchPage.length < 100) break;
      }

      if (request !== sequence.current) return;
      setWatches(list);
      setLoaded(true);
      setMoreWatches(watchPage.length === 100);
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

      const [nextDetail, firstHistory] = await Promise.all([
        rpc<WatchDetail>("issueWatch.detail", { watch_id: selected.id }),
        rpc<WatchScan[]>("issueWatch.scanHistory", {
          watch_id: selected.id,
          limit: 50,
        }),
      ]);

      if (request !== sequence.current) return;
      const nextHistory = [...firstHistory];
      let historyPage = firstHistory;
      for (let index = 1; index < historyPages && historyPage.length === 50; index++) {
        historyPage = await rpc<WatchScan[]>("issueWatch.scanHistory", {
          watch_id: selected.id,
          limit: 50,
          before: nextHistory[nextHistory.length - 1].id,
        });

        if (request !== sequence.current) return;
        nextHistory.push(...historyPage);
      }

      if (request !== sequence.current) return;
      setDetail(nextDetail);
      setHistory(nextHistory);
      setMoreHistory(historyPage.length === 50);
      const selectedScan = nextHistory.find((attempt) => attempt.id === scanId) || nextHistory[0];
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
      if (request === sequence.current) {
        setError(errorMessage(e));
        setLoaded(true);
      }
    }
  }, [enabled, archived, watchId, scanId, watchPages, historyPages]);

  useEffect(() => setWatchPages(1), [archived]);
  useEffect(() => setHistoryPages(1), [watchId]);

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
      invalidate();
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", focus);
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, [enabled, refresh, invalidate]);

  const select = (id: string) => {
    if (id === watchId && !scanId) return;
    invalidate();
    setWatchId(id);
    setScanId("");
    setDetail(null);
    setScan(null);
  };

  return {
    loading: !loaded,
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
    moreWatches,
    moreHistory,
    loadWatches: () => setWatchPages((count) => count + 1),
    loadHistory: () => setHistoryPages((count) => count + 1),
    error,
    setError,
    refresh,
  };
};
