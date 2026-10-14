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
  outputRun: string;
  outputView: "readable" | "raw" | "prompt";
  outputStream: "stdout" | "stderr" | "events";
  outputFilter: string;
  outputSearch: string;
  outputFollow: boolean;
  followupProvider: "codex" | "antigravity";
  followupModel: string | null;
  followupEffort: string | null;
}
const views = new Map<string, TaskView>();
const listeners = new Set<() => void>();
const savedLayout = (id: string) => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`vibestar.layout.${id}`) || "{}",
    );
    return {
      tab: ["Chat", "Plan", "Usage"].includes(saved.tab) ? saved.tab : "Chat",
      contextPane:
        saved.contextPane === "pipeline"
          ? ("pipeline" as const)
          : ("none" as const),
      terminalDock: saved.terminalDock === true,
      dockMaximized: saved.dockMaximized === true,
      dockTab: [
        "Changes",
        "Problems",
        "Tests",
        "Final review",
        "Terminal",
        "Agent Output",
        "Logs",
        "Usage",
      ].includes(saved.dockTab)
        ? saved.dockTab
        : "Terminal",
      outputRun: typeof saved.outputRun === "string" ? saved.outputRun : "",
      outputView: ["readable", "raw", "prompt"].includes(saved.outputView)
        ? (saved.outputView as TaskView["outputView"])
        : ("readable" as const),
      outputStream: ["stdout", "stderr", "events"].includes(saved.outputStream)
        ? (saved.outputStream as TaskView["outputStream"])
        : ("stdout" as const),
      outputFilter: [
        "all",
        "messages",
        "commands",
        "files",
        "tests",
        "errors",
      ].includes(saved.outputFilter)
        ? saved.outputFilter
        : "all",
      outputSearch:
        typeof saved.outputSearch === "string"
          ? saved.outputSearch.slice(0, 256)
          : "",
      outputFollow: saved.outputFollow !== false,
    };
  } catch {
    return {};
  }
};
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
      outputRun: "",
      outputView: "readable",
      outputStream: "stdout",
      outputFilter: "all",
      outputSearch: "",
      outputFollow: true,
      followupProvider: "codex",
      followupModel: null,
      followupEffort: null,
      ...savedLayout(id),
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
  const {
    tab,
    contextPane,
    terminalDock,
    dockMaximized,
    dockTab,
    outputRun,
    outputView,
    outputStream,
    outputFilter,
    outputSearch,
    outputFollow,
  } = state(id);
  localStorage.setItem(
    `vibestar.layout.${id}`,
    JSON.stringify({
      tab,
      contextPane,
      terminalDock,
      dockMaximized,
      dockTab,
      outputRun,
      outputView,
      outputStream,
      outputFilter,
      outputSearch,
      outputFollow,
    }),
  );
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
