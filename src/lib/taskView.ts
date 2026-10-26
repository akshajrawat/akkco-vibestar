import { useSyncExternalStore } from "react";

export const workspaceSections = {
  pipeline: "Workflow",
  plans: "Plans",
  changes: "Changes",
  tests: "Checks",
  "final-review": "Final review",
  usage: "Usage",
  "run-details": "Run details",
  logs: "Raw logs",
} as const;
export type SecondarySection = keyof typeof workspaceSections;
export interface ContextAttachment {
  id: string;
  label: string;
  text: string;
}
interface TaskView {
  draft: string;
  gitMessageDraft: string;
  gitStep: number;
  draftContext: ContextAttachment[];
  messageRequest: { id: string; signature: string } | null;
  savedInstruction: { id: string; content: string } | null;
  secondaryOpen: boolean;
  secondarySection: SecondarySection;
  secondaryPrevious: SecondarySection | null;
  secondaryWidth: number;
  secondaryScroll: Partial<Record<SecondarySection, number>>;
  planStage: 1 | 2;
  expandedTool: boolean;
  terminalDock: boolean;
  dockMaximized: boolean;
  dockTab: "Terminal" | "Problems";
  bottomHeight: number;
  chatScroll: number;
  chatFollow: boolean;
  approvalCompact: boolean;
  diffMode: "unified" | "side";
  diffTree: "tree" | "flat";
  diffLayer: "original" | "upstream" | "repair";
  diffLayerPaths: Partial<Record<"original" | "upstream" | "repair", string>>;
  diffPath: string;
  diffSelections: Record<string, { start: number; end: number; side: "base" | "working" }>;
  diffReview: boolean;
  fullContext: boolean;
  openFile: boolean;
  outputRun: string;
  outputView: "readable" | "raw" | "prompt";
  outputStream: "stdout" | "stderr" | "events";
  outputFilter: string;
  outputSearch: string;
  outputFollow: boolean;
  followupProvider: "codex" | "antigravity";
  followupModel: string | null;
  followupEffort: string | null;
  persistenceError: string | null;
}
const views = new Map<string, TaskView>();
const listeners = new Set<() => void>();
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
const section = (value: unknown): SecondarySection | null =>
  typeof value === "string" && Object.hasOwn(workspaceSections, value)
    ? (value as SecondarySection)
    : null;
const legacySections: Record<string, SecondarySection> = {
  Plan: "plans",
  Usage: "usage",
  Changes: "changes",
  Tests: "tests",
  "Final review": "final-review",
  Logs: "logs",
  "Agent Output": "logs",
};
const legacySection = (value: unknown) =>
  typeof value === "string" && Object.hasOwn(legacySections, value) ? legacySections[value] : null;
const savedLayout = (id: string): Partial<TaskView> => {
  try {
    const raw = read(`vibestar.layout.${id}`);
    const value: unknown = JSON.parse(raw || "{}");
    const saved =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const migrated =
      legacySection(saved.tab) || (saved.terminalDock ? legacySection(saved.dockTab) : null);
    return {
      gitMessageDraft: typeof saved.gitMessageDraft === "string" ? saved.gitMessageDraft : "",
      savedInstruction:
        saved.savedInstruction &&
        typeof saved.savedInstruction === "object" &&
        typeof (saved.savedInstruction as Record<string, unknown>).id === "string" &&
        typeof (saved.savedInstruction as Record<string, unknown>).content === "string" &&
        String((saved.savedInstruction as Record<string, unknown>).content).length <= 32000
          ? (saved.savedInstruction as TaskView["savedInstruction"])
          : null,
      draftContext: Array.isArray(saved.draftContext)
        ? saved.draftContext
            .filter(
              (entry): entry is ContextAttachment =>
                !!entry &&
                typeof entry === "object" &&
                typeof entry.id === "string" &&
                entry.id.length <= 100 &&
                typeof entry.label === "string" &&
                entry.label.length <= 180 &&
                typeof entry.text === "string" &&
                entry.text.length <= 4500,
            )
            .slice(0, 6)
        : [],
      messageRequest:
        saved.messageRequest &&
        typeof saved.messageRequest === "object" &&
        typeof (saved.messageRequest as Record<string, unknown>).id === "string" &&
        typeof (saved.messageRequest as Record<string, unknown>).signature === "string" &&
        String((saved.messageRequest as Record<string, unknown>).signature).length <= 50000
          ? (saved.messageRequest as TaskView["messageRequest"])
          : null,
      secondaryOpen:
        typeof saved.secondaryOpen === "boolean"
          ? saved.secondaryOpen
          : raw
            ? !!(migrated || saved.contextPane === "pipeline")
            : window.innerWidth >= 1400,
      secondarySection: section(saved.secondarySection) || migrated || "pipeline",
      secondaryPrevious: section(saved.secondaryPrevious),
      secondaryScroll: Object.fromEntries(
        Object.keys(workspaceSections).flatMap((key) => {
          const positions = saved.secondaryScroll;
          const position =
            positions && typeof positions === "object"
              ? (positions as Record<string, unknown>)[key]
              : null;
          return typeof position === "number" && Number.isFinite(position) && position >= 0
            ? [[key, Math.min(position, Number.MAX_SAFE_INTEGER)]]
            : [];
        }),
      ),
      planStage: saved.planStage === 2 ? (2 as const) : (1 as const),
      gitStep: [0, 1, 2, 3].includes(Number(saved.gitStep)) ? Number(saved.gitStep) : 0,
      secondaryWidth: bounded(
        saved.secondaryWidth,
        bounded(Number(read("vibestar.contextWidth")) || 380, 380, 300, 640),
        300,
        640,
      ),
      expandedTool: saved.expandedTool === true,
      terminalDock:
        saved.terminalDock === true && ["Terminal", "Problems"].includes(String(saved.dockTab)),
      dockTab: saved.dockTab === "Problems" ? ("Problems" as const) : ("Terminal" as const),
      dockMaximized:
        saved.dockMaximized === true && ["Terminal", "Problems"].includes(String(saved.dockTab)),
      bottomHeight: bounded(
        saved.bottomHeight,
        bounded(Number(read("vibestar.dockHeight")) || 260, 260, 140, 700),
        140,
        700,
      ),
      chatScroll: bounded(saved.chatScroll, 0, 0, Number.MAX_SAFE_INTEGER),
      chatFollow: saved.chatFollow !== false,
      approvalCompact: saved.approvalCompact === true,
      diffPath: typeof saved.diffPath === "string" ? saved.diffPath : "",
      diffMode: saved.diffMode === "unified" ? ("unified" as const) : ("side" as const),
      diffTree: saved.diffTree === "flat" ? ("flat" as const) : ("tree" as const),
      diffLayer:
        saved.diffLayer === "original" || saved.diffLayer === "upstream"
          ? saved.diffLayer
          : ("repair" as const),
      diffLayerPaths: Object.fromEntries(
        ["original", "upstream", "repair"].flatMap((key) => {
          const paths = saved.diffLayerPaths;
          const value =
            paths && typeof paths === "object"
              ? (paths as Record<string, unknown>)[key]
              : undefined;
          return typeof value === "string" && value.length < 4000 ? [[key, value]] : [];
        }),
      ),
      outputRun: typeof saved.outputRun === "string" ? saved.outputRun : "",
      outputView: ["readable", "raw", "prompt"].includes(String(saved.outputView))
        ? (saved.outputView as TaskView["outputView"])
        : ("readable" as const),
      outputStream: ["stdout", "stderr", "events"].includes(String(saved.outputStream))
        ? (saved.outputStream as TaskView["outputStream"])
        : ("stdout" as const),
      outputFilter: ["all", "messages", "commands", "files", "tests", "errors"].includes(
        String(saved.outputFilter),
      )
        ? String(saved.outputFilter)
        : "all",
      outputSearch: typeof saved.outputSearch === "string" ? saved.outputSearch.slice(0, 256) : "",
      outputFollow: saved.outputFollow !== false,
      followupProvider:
        saved.followupProvider === "antigravity" ? ("antigravity" as const) : ("codex" as const),
      followupModel: typeof saved.followupModel === "string" ? saved.followupModel : null,
      followupEffort: typeof saved.followupEffort === "string" ? saved.followupEffort : null,
    };
  } catch {
    return {};
  }
};
const state = (id: string) => {
  let value = views.get(id);
  if (!value) {
    value = {
      draft: read(`vibestar.draft.${id}`) || "",
      gitMessageDraft: "",
      gitStep: 0,
      draftContext: [],
      messageRequest: null,
      savedInstruction: null,
      secondaryOpen: false,
      secondarySection: "pipeline",
      secondaryPrevious: null,
      secondaryWidth: 380,
      secondaryScroll: {},
      planStage: 1,
      expandedTool: false,
      terminalDock: false,
      dockMaximized: false,
      dockTab: "Terminal",
      bottomHeight: 260,
      chatScroll: 0,
      chatFollow: true,
      approvalCompact: false,
      diffMode: "side",
      diffTree: "tree",
      diffLayer: "repair",
      diffLayerPaths: {},
      diffPath: "",
      diffSelections: {},
      diffReview: false,
      fullContext: false,
      openFile: false,
      outputRun: "",
      outputView: "readable",
      outputStream: "stdout",
      outputFilter: "all",
      outputSearch: "",
      outputFollow: true,
      followupProvider: "codex",
      followupModel: null,
      followupEffort: null,
      persistenceError: null,
      ...savedLayout(id),
    };
    views.set(id, value);
  }
  return value;
};
export const updateTaskView = (id: string, update: Partial<TaskView>) => {
  const value = {
    ...state(id),
    ...update,
    persistenceError: null as string | null,
  };
  try {
    if (update.draft !== undefined || state(id).persistenceError) {
      if (value.draft) localStorage.setItem(`vibestar.draft.${id}`, value.draft);
      else localStorage.removeItem(`vibestar.draft.${id}`);
    }
    const layout = {
      ...value,
      draft: undefined,
      persistenceError: undefined,
      diffSelections: undefined,
    };
    localStorage.setItem(`vibestar.layout.${id}`, JSON.stringify({ version: 2, ...layout }));
  } catch {
    value.persistenceError =
      "Local storage is unavailable. Keep this conversation open and copy your draft before closing.";
  }
  views.set(id, value);
  for (const listener of listeners) listener();
};
export const openWorkspaceTool = (id: string, selected: SecondarySection) => {
  const current = state(id);
  updateTaskView(id, {
    ...(selected === "logs" &&
    current.secondarySection !== "logs" &&
    current.outputView === "readable"
      ? { outputView: "raw" }
      : {}),
    secondaryOpen: true,
    secondarySection: selected,
    ...(selected !== current.secondarySection
      ? { secondaryPrevious: current.secondarySection }
      : {}),
  });
};
export const useTaskView = (id: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state(id),
  );
