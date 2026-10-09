import { useSyncExternalStore } from "react";
interface TaskView {
  tab: string;
  draft: string;
  diffMode: string;
  diffPath: string;
  diffSelections: Record<
    string,
    { start: number; end: number; side: "base" | "working" }
  >;
  diffReview: boolean;
  fullContext: boolean;
  openFile: boolean;
  terminalDock: boolean;
  dockMaximized: boolean;
  dockTab: string;
  contextPane: "none" | "pipeline" | "changes";
  followupProvider: "codex" | "antigravity";
  followupModel: string | null;
  followupEffort: string | null;
}
const views = new Map<string, TaskView>();
const listeners = new Set<() => void>();
const state = (id: string) => {
  let value = views.get(id);
  if (!value) {
    value = {
      tab: "Chat",
      draft: localStorage.getItem(`vibestar.draft.${id}`) || "",
      diffMode: "side",
      diffPath: "",
      diffSelections: {},
      diffReview: false,
      fullContext: false,
      openFile: false,
      terminalDock: false,
      dockMaximized: false,
      dockTab: "Terminal",
      contextPane: "none",
      followupProvider: "codex",
      followupModel: null,
      followupEffort: null,
    };
    views.set(id, value);
  }
  return value;
};
export const updateTaskView = (id: string, update: Partial<TaskView>) => {
  if (update.draft !== undefined) {
    if (update.draft)
      localStorage.setItem(`vibestar.draft.${id}`, update.draft);
    else localStorage.removeItem(`vibestar.draft.${id}`);
  }
  views.set(id, { ...state(id), ...update });
  for (const listener of listeners) listener();
};
export const useTaskView = (id: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state(id),
  );
