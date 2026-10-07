import { useEffect, useState, useRef } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
export const TitleBar = ({
  onPalette,
  currentTask,
  onSidebar,
}: {
  onPalette?: () => void;
  currentTask?: string;
  onSidebar?: () => void;
} = {}) => {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState("");
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const manualDragging = window.electronWindow.manualDragging;
  useEffect(() => {
    let mounted = true;
    void window.electronWindow
      .getState()
      .then((value) => {
        if (mounted) {
          setMaximized(value.maximized);
          setFullscreen(value.fullscreen);
        }
      })
      .catch((e) => setError(String(e)));
    const key = (event: KeyboardEvent) => {
      if (event.key === "F11" && !event.repeat) {
        event.preventDefault();
        void window.electronWindow.fullscreen();
      }
      if (event.key === "Escape" && fullscreen) {
        event.preventDefault();
        void window.electronWindow.fullscreen();
      }
    };
    window.addEventListener("keydown", key);
    const unsubscribe = window.electronWindow.onStateChanged((value) => {
      setMaximized(value.maximized);
      setFullscreen(value.fullscreen);
    });
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("keydown", key);
    };
  }, [fullscreen]);
  const control = (action: () => Promise<void>) =>
    void action().catch((e) => setError(String(e)));
  return (
    <header
      className={`titlebar ${manualDragging ? "titlebar-manual" : ""}`}
      onPointerDown={(event) => {
        if (
          !manualDragging ||
          event.button !== 0 ||
          (event.target as HTMLElement).closest("button")
        )
          return;
        dragStart.current = { x: event.screenX, y: event.screenY };
        event.currentTarget.setPointerCapture(event.pointerId);
        control(() => window.electronWindow.beginDrag(dragStart.current!));
      }}
      onPointerMove={(event) => {
        const start = dragStart.current;
        if (
          !start ||
          Math.abs(start.x - event.screenX) +
            Math.abs(start.y - event.screenY) <
            4
        )
          return;
        control(() =>
          window.electronWindow.drag({ x: event.screenX, y: event.screenY }),
        );
      }}
      onPointerUp={() => {
        if (dragStart.current) control(window.electronWindow.endDrag);
        dragStart.current = null;
      }}
      onLostPointerCapture={() => {
        if (dragStart.current) control(window.electronWindow.endDrag);
        dragStart.current = null;
      }}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest("button"))
          control(window.electronWindow.maximize);
      }}
    >
      {onSidebar && (
        <button
          className="sidebar-toggle"
          aria-label="Toggle sidebar"
          onClick={onSidebar}
        >
          ☰
        </button>
      )}
      <span className="titlebar-name">akkco vibestar</span>
      {onPalette && (
        <button
          className="titlebar-palette"
          aria-label="Open command palette"
          onClick={onPalette}
        >
          {currentTask || "Search tasks and commands"} <kbd>Ctrl+Shift+P</kbd>
        </button>
      )}
      {error && (
        <span role="alert" className="titlebar-error">
          {error}
        </span>
      )}
      <div className="window-controls" aria-label="Window controls">
        <button
          aria-label="Minimize window"
          onClick={() => control(window.electronWindow.minimize)}
        >
          <Minus size={14} />
        </button>
        <button
          aria-label={
            fullscreen
              ? "Exit fullscreen"
              : maximized
                ? "Restore window"
                : "Maximize window"
          }
          onClick={() => control(window.electronWindow.maximize)}
        >
          {maximized || fullscreen ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          className="window-close"
          aria-label="Close window"
          onClick={() => control(window.electronWindow.close)}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
};
