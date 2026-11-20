import { screen, type BrowserWindow } from "electron";
import { z } from "zod";

export const configureWindowControls = (window: BrowserWindow, isWslg: boolean) => {
  let restoreBounds: Electron.Rectangle | null = null;
  let fallbackMaximized = false;
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;

  const state = () => ({
    maximized: window.isMaximized() || fallbackMaximized,
    fullscreen: window.isFullScreen(),
  });

  let publishedState: ReturnType<typeof state> | null = null;

  const publishState = () => {
    const current = state();
    if (
      publishedState?.maximized === current.maximized &&
      publishedState.fullscreen === current.fullscreen
    ) {
      return;
    }

    publishedState = current;
    window.webContents.send("window:state", current);
  };

  const setFullscreen = (fullscreen: boolean) => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
    }

    boundsTimer = undefined;
    window.setFullScreen(fullscreen);
  };

  const toggleMaximize = () => {
    if (window.isFullScreen()) {
      setFullscreen(false);
      return;
    }

    if (boundsTimer) {
      clearTimeout(boundsTimer);
    }

    if (state().maximized) {
      window.unmaximize();
      if (fallbackMaximized && restoreBounds) {
        window.setBounds(restoreBounds);
      }

      fallbackMaximized = false;
      publishState();
      return;
    }

    restoreBounds = window.getBounds();
    const workArea = screen.getDisplayMatching(restoreBounds).workArea;
    window.maximize();
    // WSLg may acknowledge maximize without resizing. Windows owns its native
    // transition and DPI geometry; a timed setBounds would fight that transition.
    if (!isWslg) {
      return;
    }

    boundsTimer = setTimeout(() => {
      if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) {
        return;
      }

      const bounds = window.getBounds();
      if (
        Math.abs(bounds.x - workArea.x) > 20 ||
        Math.abs(bounds.y - workArea.y) > 20 ||
        Math.abs(bounds.width - workArea.width) > 20 ||
        Math.abs(bounds.height - workArea.height) > 20
      ) {
        window.unmaximize();
        fallbackMaximized = true;
        window.setBounds(workArea);
      }

      publishState();
    }, 250);
  };

  const pointSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  });

  let dragOrigin: {
    point: { x: number; y: number };
    bounds: Electron.Rectangle;
  } | null = null;

  const dragStart = (input: unknown) => {
    const point = pointSchema.parse(input);
    const current = state();

    dragOrigin =
      !current.maximized && !current.fullscreen ? { point, bounds: window.getBounds() } : null;
  };

  const drag = (input: unknown) => {
    const point = pointSchema.parse(input);
    if (dragOrigin) {
      window.setPosition(
        Math.round(dragOrigin.bounds.x + point.x - dragOrigin.point.x),
        Math.round(dragOrigin.bounds.y + point.y - dragOrigin.point.y),
      );
    }
  };

  window.on("maximize", publishState);
  window.on("unmaximize", publishState);
  window.on("enter-full-screen", publishState);
  window.on("leave-full-screen", publishState);
  window.on("resize", publishState);

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11" && !input.isAutoRepeat) {
      event.preventDefault();
      setFullscreen(!window.isFullScreen());
    }

    if (input.type === "keyDown" && input.key === "Escape" && window.isFullScreen()) {
      event.preventDefault();
      setFullscreen(false);
    }
  });

  window.once("closed", () => {
    if (boundsTimer) {
      clearTimeout(boundsTimer);
    }
  });

  return {
    state,
    minimize: () => window.minimize(),
    maximize: toggleMaximize,
    fullscreen: () => setFullscreen(!window.isFullScreen()),
    close: () => window.close(),
    dragStart,
    drag,
    dragEnd: () => {
      dragOrigin = null;
    },
  };
};
