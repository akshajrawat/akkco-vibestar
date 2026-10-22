import { useEffect, useState } from "react";
import { subscribe } from "../api";

export const useWatchNotifications = (enabled: boolean) => {
  const [notices, setNotices] = useState<
    { id: string; watchId: string; text: string }[]
  >([]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let saved: string[] = [];
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem("vibestar.issueWatch.notified") || "[]",
      );
      if (Array.isArray(value))
        saved = value.filter((id) => typeof id === "string").slice(-500);
    } catch {
      /* Invalid local display preferences have no execution authority. */
    }
    const seen = new Set(saved);
    const subscription = subscribe((event) => {
      if (
        disposed ||
        event.event !== "issue-watch.completed" ||
        !event.scan_id ||
        !event.watch_id ||
        seen.has(event.scan_id)
      )
        return;
      const data = event.data as
        { status?: string; summary?: Record<string, number> } | undefined;
      if (!data || !["completed", "partial"].includes(data.status || ""))
        return;
      seen.add(event.scan_id);
      localStorage.setItem(
        "vibestar.issueWatch.notified",
        JSON.stringify([...seen].slice(-500)),
      );
      const counts = data.summary || {};
      const newly =
        (counts.new_issue || 0) +
        (counts.newly_matching || 0) +
        (counts.reentered || 0);
      const discoveries = counts.initial_discovery || 0;
      const text = `${data.status === "partial" ? "Partial scan" : "Scan complete"} — ${discoveries ? `${discoveries} initial discoveries` : counts.criteria_changed ? `${counts.criteria_changed} matching after criteria changed` : `${newly} newly matching`}, ${counts.existing_match || 0} existing matches, ${counts.manual_review || 0} require manual review.`;
      setNotices((current) => [
        ...current.slice(-9),
        { id: event.scan_id!, watchId: event.watch_id!, text },
      ]);
    });
    return () => {
      disposed = true;
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, [enabled]);
  return {
    notices,
    dismiss: (id: string) =>
      setNotices((current) => current.filter((notice) => notice.id !== id)),
  };
};
