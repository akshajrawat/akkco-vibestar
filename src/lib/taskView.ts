import { useSyncExternalStore } from "react";
interface TaskView {
  tab: string;
  draft: string;
  diffMode: string;
  diffPath: string;
  diffReview: boolean;
  fullContext: boolean;
  openFile: boolean;
  terminalDock: boolean;
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
      draft: "",
      diffMode: "side",
      diffPath: "",
      diffReview: false,
      fullContext: false,
      openFile: false,
      terminalDock: false,
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
