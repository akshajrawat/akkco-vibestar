import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useTaskView, updateTaskView } from "../../lib/taskView";
import { navigateTabs, focusWorkspace } from "../../lib/keyboard";
import { ResizeHandle } from "../ResizeHandle";
import { Button } from "../ui/button";

export const BottomDock = ({
  id,
  terminal,
  problems,
}: {
  id: string;
  terminal: React.ReactNode;
  problems: React.ReactNode;
}) => {
  const view = useTaskView(id);
  const surface = useRef<HTMLElement>(null);
  const [attached, setAttached] = useState(
    view.terminalDock && view.dockTab === "Terminal",
  );
  useEffect(() => {
    if (view.terminalDock && view.dockTab === "Terminal") setAttached(true);
  }, [view.terminalDock, view.dockTab]);
  return (
    <>
      {view.terminalDock && !view.dockMaximized && (
        <ResizeHandle
          label="Resize utility dock"
          value={view.bottomHeight}
          min={140}
          max={700}
          vertical
          reverse
          onChange={(bottomHeight) => updateTaskView(id, { bottomHeight })}
        />
      )}
      <section
        ref={surface}
        className="utility-dock bottom-dock"
        hidden={!view.terminalDock}
        style={view.dockMaximized ? undefined : { height: view.bottomHeight }}
        aria-label="Terminal and problems"
      >
        <div
          className="dock-tabs"
          role="tablist"
          aria-label="Utilities"
          onKeyDown={navigateTabs}
        >
          {(["Terminal", "Problems"] as const).map((name) => (
            <button
              key={name}
              role="tab"
              tabIndex={view.dockTab === name ? 0 : -1}
              aria-selected={view.dockTab === name}
              onClick={() => updateTaskView(id, { dockTab: name })}
            >
              {name}
            </button>
          ))}
          <span className="spacer" />
          <Button
            size="icon"
            variant="ghost"
            aria-label={
              view.dockMaximized
                ? "Restore utility dock"
                : "Maximize utility dock"
            }
            aria-pressed={view.dockMaximized}
            onClick={() =>
              updateTaskView(id, { dockMaximized: !view.dockMaximized })
            }
          >
            {view.dockMaximized ? (
              <Minimize2 size={13} />
            ) : (
              <Maximize2 size={13} />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Hide utility dock"
            onClick={() => {
              updateTaskView(id, { terminalDock: false });
              focusWorkspace(surface.current?.closest(".workspace"));
            }}
          >
            <X size={13} />
          </Button>
        </div>
        <div className="dock-content" hidden={view.dockTab !== "Terminal"}>
          {attached && terminal}
        </div>
        {view.dockTab === "Problems" && (
          <div className="dock-content">{problems}</div>
        )}
      </section>
    </>
  );
};
