import { useEffect } from "react";
import { useTaskView, updateTaskView } from "../lib/taskView";
import { focusWorkspace } from "../lib/keyboard";

export const useWorkspaceKeys = (id: string) => {
  const view = useTaskView(id);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      if (e.key === "`" || e.key.toLowerCase() === "j") {
        e.preventDefault();
        const root = document.activeElement?.closest(".workspace");
        updateTaskView(id, {
          terminalDock: !view.terminalDock,
          ...(e.key === "`" ? { dockTab: "Terminal" } : {}),
        });
        if (view.terminalDock) focusWorkspace(root);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [id, view.terminalDock]);
};
