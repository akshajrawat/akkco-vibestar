import { useSyncExternalStore } from "react";

export interface ContextAttachment {
  id: string;
  label: string;
  text: string;
}

export interface TaskView {
  draft: string;
  draftContext: ContextAttachment[];
  messageRequest: { id: string; signature: string } | null;
  chatScroll: number;
  chatFollow: boolean;
  expandedTool: boolean;
  followupProvider: "codex" | "antigravity" | null;
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

const savedLayout = (id: string): Partial<TaskView> => {
  try {
    const raw = read(`vibestar.layout.${id}`);
    const value: unknown = JSON.parse(raw || "{}");

    const saved =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return {
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
      expandedTool: saved.expandedTool === true,
      chatScroll: bounded(saved.chatScroll, 0, 0, Number.MAX_SAFE_INTEGER),
      chatFollow: saved.chatFollow !== false,
      followupProvider:
        saved.followupProvider === "antigravity" || saved.followupProvider === "codex"
          ? saved.followupProvider
          : null,
      followupModel: typeof saved.followupModel === "string" ? saved.followupModel : null,
      followupEffort: typeof saved.followupEffort === "string" ? saved.followupEffort : null,
    };
  } catch {
    return {};
  }
};

const state = (id: string): TaskView => {
  let value = views.get(id);
  if (!value) {
    value = {
      draft: read(`vibestar.draft.${id}`) || "",
      draftContext: [],
      messageRequest: null,
      expandedTool: false,
      chatScroll: 0,
      chatFollow: true,
      followupProvider: null,
      followupModel: null,
      followupEffort: null,
      persistenceError: null,
      ...savedLayout(id),
    };

    views.set(id, value);
  }

  return value;
};

export const getTaskView = (id: string) => state(id);

export const updateTaskView = (id: string, update: Partial<TaskView>) => {
  const previous = state(id);

  const value: TaskView = {
    ...previous,
    ...update,
    persistenceError: null as string | null,
  };

  try {
    if (update.draft !== undefined || state(id).persistenceError) {
      if (value.draft) {
        localStorage.setItem(`vibestar.draft.${id}`, value.draft);
      } else {
        localStorage.removeItem(`vibestar.draft.${id}`);
      }
    }

    const layout = {
      ...value,
      draft: undefined,
      persistenceError: undefined,
    };

    localStorage.setItem(`vibestar.layout.${id}`, JSON.stringify({ version: 2, ...layout }));
  } catch {
    value.persistenceError =
      "Local storage is unavailable. Keep this conversation open and copy your draft before closing.";
  }

  views.set(id, value);
  for (const listener of listeners) {
    listener();
  }
};

export const useTaskView = (id: string) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state(id),
  );
