import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Expand, Minimize2, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import {
  useTaskView,
  updateTaskView,
  openWorkspaceTool,
  workspaceSections,
  type SecondarySection,
} from "../../lib/taskView";
import { containDialogFocus, navigateTabs, focusWorkspace } from "../../lib/keyboard";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { ResizeHandle } from "../../components/shared/ResizeHandle";
import { Button } from "../../components/ui/button";

export const SecondaryWorkspace = ({ id, children }: { id: string; children: React.ReactNode }) => {
  const view = useTaskView(id);
  const reduced = useReducedMotion();
  const anchor = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(view.secondaryScroll);
  const expanded = useRef(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  scrollPositions.current = view.secondaryScroll;
  const [narrow, setNarrow] = useState(window.innerWidth < 1200);
  const dialog = useDialogFocus(view.secondaryOpen && narrow && !view.expandedTool);
  useEffect(() => {
    if (view.secondaryOpen && view.expandedTool && !expanded.current) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement && document.activeElement !== document.body
          ? document.activeElement
          : null;
      dialog.current
        ?.querySelector<HTMLButtonElement>("button[aria-label='Return to chat']")
        ?.focus();
    } else if (view.secondaryOpen && !view.expandedTool && expanded.current) {
      if (narrow)
        dialog.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      else if (previousFocus.current?.isConnected) previousFocus.current.focus();
      else focusWorkspace(anchor.current?.closest(".workspace"));
    }
    expanded.current = view.expandedTool;
  }, [view.expandedTool, view.secondaryOpen, narrow, dialog]);
  useEffect(() => {
    if (content.current)
      content.current.scrollTop = scrollPositions.current[view.secondarySection] || 0;
  }, [view.secondarySection, view.secondaryOpen, view.expandedTool]);
  useEffect(() => {
    const parent = anchor.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNarrow(parent.clientWidth < 960));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const close = () => {
    updateTaskView(id, { secondaryOpen: false, expandedTool: false });
    anchor.current
      ?.closest(".workspace")
      ?.querySelector<HTMLButtonElement>(".secondary-toggle")
      ?.focus();
  };
  return (
    <>
      <div ref={anchor} className="secondary-anchor" />
      {view.secondaryOpen && (
        <>
          {narrow && !view.expandedTool && (
            <button
              className="secondary-backdrop"
              aria-label="Dismiss workspace tools"
              onClick={close}
            />
          )}
          {!narrow && !view.expandedTool && (
            <ResizeHandle
              label="Resize secondary workspace"
              value={view.secondaryWidth}
              min={300}
              max={640}
              reverse
              onChange={(secondaryWidth) => updateTaskView(id, { secondaryWidth })}
            />
          )}
          <aside
            ref={dialog}
            className={`context-pane secondary-workspace ${narrow ? "secondary-drawer" : ""} ${view.expandedTool ? "secondary-expanded" : ""}`}
            style={{ width: view.secondaryWidth }}
            role={narrow && !view.expandedTool ? "dialog" : "complementary"}
            aria-modal={narrow && !view.expandedTool ? true : undefined}
            aria-label="Secondary workspace"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                if (view.expandedTool) updateTaskView(id, { expandedTool: false });
                else close();
              }
              if (narrow && !view.expandedTool) containDialogFocus(e);
            }}
          >
            <header className="secondary-heading">
              <strong>{workspaceSections[view.secondarySection]}</strong>
              <span className="spacer" />
              {view.secondaryPrevious && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Back to ${workspaceSections[view.secondaryPrevious]}`}
                  onClick={() => openWorkspaceTool(id, view.secondaryPrevious!)}
                >
                  <ArrowLeft size={14} />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                aria-label={view.expandedTool ? "Return to chat" : "Expand workspace tool"}
                onClick={() => updateTaskView(id, { expandedTool: !view.expandedTool })}
              >
                {view.expandedTool ? <Minimize2 size={14} /> : <Expand size={14} />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Collapse secondary workspace"
                onClick={close}
              >
                <X size={14} />
              </Button>
            </header>
            <div
              role="tablist"
              aria-label="Workspace tools"
              className="workspace-tool-tabs"
              onKeyDown={navigateTabs}
            >
              {Object.entries(workspaceSections).map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  tabIndex={view.secondarySection === key ? 0 : -1}
                  aria-selected={view.secondarySection === key}
                  aria-controls={`workspace-tool-${id}`}
                  id={`workspace-tool-${id}-${key}`}
                  onClick={() => openWorkspaceTool(id, key as SecondarySection)}
                >
                  {view.secondarySection === key && (
                    <motion.span
                      className="workspace-tab-selection"
                      layoutId={`workspace-tab-${id}`}
                      transition={{ duration: reduced ? 0 : 0.16 }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="workspace-tab-label">{label}</span>
                </button>
              ))}
            </div>
            <div
              className="secondary-content"
              ref={content}
              onScroll={(e) =>
                updateTaskView(id, {
                  secondaryScroll: {
                    ...view.secondaryScroll,
                    [view.secondarySection]: e.currentTarget.scrollTop,
                  },
                })
              }
              role="tabpanel"
              id={`workspace-tool-${id}`}
              aria-labelledby={`workspace-tool-${id}-${view.secondarySection}`}
              key={view.secondarySection}
            >
              {children}
            </div>
          </aside>
        </>
      )}
    </>
  );
};
