import { useEffect, useState, useRef, type Ref } from "react";
import { Minus, Square, Copy, X, PanelLeftOpen, PanelRight } from "lucide-react";

import type { AgentProfile } from "../../core/vibers/contracts";
import { ViberFace } from "../features/vibers/ViberFace";

export const TitleBar = ({
  profile,
  onSidebar,
  toggleRef,
  onComputer,
  computerOpen,
}: {
  onComputer?: () => void;
  computerOpen?: boolean;
  profile?: AgentProfile;
  onSidebar?: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
} = {}) => {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
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

      if (event.key === "Escape" && fullscreenRef.current) {
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
  }, []);

  const control = (action: () => Promise<void>) => void action().catch((e) => setError(String(e)));
  return (
    <header
      className={`titlebar flex items-center border-b border-b-border select-none ${manualDragging ? "titlebar-manual" : ""}`}
      onPointerDown={(event) => {
        if (
          !manualDragging ||
          event.button !== 0 ||
          (event.target as HTMLElement).closest("button")
        ) {
          return;
        }

        dragStart.current = { x: event.screenX, y: event.screenY };
        event.currentTarget.setPointerCapture(event.pointerId);
        control(() => window.electronWindow.beginDrag(dragStart.current!));
      }}
      onPointerMove={(event) => {
        const start = dragStart.current;
        if (!start || Math.abs(start.x - event.screenX) + Math.abs(start.y - event.screenY) < 4) {
          return;
        }

        control(() => window.electronWindow.drag({ x: event.screenX, y: event.screenY }));
      }}
      onPointerUp={() => {
        if (dragStart.current) {
          control(window.electronWindow.endDrag);
        }

        dragStart.current = null;
      }}
      onLostPointerCapture={() => {
        if (dragStart.current) {
          control(window.electronWindow.endDrag);
        }

        dragStart.current = null;
      }}
      onDoubleClick={(event) => {
        if (!(event.target as HTMLElement).closest("button")) {
          control(window.electronWindow.maximize);
        }
      }}
    >
      {onSidebar && (
        <button
          ref={toggleRef}
          className="titlebar-action grid place-items-center shrink-0 p-0 [border:0] focus-visible:[outline:1px_solid_var(--focus-ring)] focus-visible:outline-offset-[-2px]"
          aria-label="Expand sidebar"
          aria-expanded="false"
          title="Expand sidebar (Ctrl+B)"
          onClick={onSidebar}
        >
          <PanelLeftOpen size={18} aria-hidden="true" />
        </button>
      )}
      <div className="titlebar-identity flex flex-1 min-w-0 items-center gap-1.5 px-3">
        {profile && <ViberFace profile={profile} compact className="size-[54px] shrink-0" />}
        <strong className="truncate text-[16px] font-bold">{profile?.name || "Vibestar"}</strong>
      </div>

      {error && (
        <span role="alert" className="text-[11px] text-accent-red">
          {error}
        </span>
      )}

      {onComputer && (
        <button
          className="titlebar-action grid place-items-center shrink-0 p-0 [border:0] focus-visible:[outline:1px_solid_var(--focus-ring)] focus-visible:outline-offset-[-2px]"
          aria-label="Toggle computer panel"
          aria-expanded={computerOpen}
          title="Toggle computer panel"
          onClick={onComputer}
        >
          <PanelRight size={20} aria-hidden="true" />
        </button>
      )}
      <div className="window-controls shrink-0 flex ml-auto" aria-label="Window controls">
        <button
          aria-label="Minimize window"
          onClick={() => control(window.electronWindow.minimize)}
        >
          <Minus size={17} />
        </button>

        <button
          aria-label={
            fullscreen ? "Exit fullscreen" : maximized ? "Restore window" : "Maximize window"
          }
          onClick={() => control(window.electronWindow.maximize)}
        >
          {maximized || fullscreen ? <Copy size={15} /> : <Square size={15} />}
        </button>

        <button
          className="window-close"
          aria-label="Close window"
          onClick={() => control(window.electronWindow.close)}
        >
          <X size={18} />
        </button>
      </div>
    </header>
  );
};
