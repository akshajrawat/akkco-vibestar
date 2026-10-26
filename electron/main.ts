import { app, BrowserWindow, ipcMain, shell, Menu, screen } from "electron";
import { mkdir, writeFile, cp, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { z } from "zod";
import { CoreBridge, readDesktopConfig, saveDesktopConfig } from "./bridge";

const exec = promisify(execFile);
const isWslg = process.platform === "linux" && !!process.env.WSL_DISTRO_NAME;
// WSLg exposes Xwayland window geometry; Wayland does not guarantee positioning.
if (isWslg) app.commandLine.appendSwitch("ozone-platform", "x11");
let window: BrowserWindow | null = null;
let bridge: CoreBridge | null = null;
let quitting = false;

const main = async () => {
  const previousProfile = app.getPath("userData");

  const profile =
    !app.isPackaged && process.env.VIBESTAR_USER_DATA
      ? process.env.VIBESTAR_USER_DATA
      : process.platform === "linux"
        ? join(
            process.env.VIBESTAR_HOME || join(homedir(), ".akkco-vibestar"),
            "runtime",
            "desktop",
          )
        : null;

  if (profile) {
    await mkdir(profile, { recursive: true });
    if (
      process.platform === "linux" &&
      !process.env.VIBESTAR_USER_DATA &&
      previousProfile !== profile
    ) {
      for (const name of ["desktop.json", "Local Storage", "Preferences"]) {
        const target = join(profile, name);
        if (
          await access(target)
            .then(() => false)
            .catch(() => true)
        ) {
          await cp(join(previousProfile, name), target, {
            recursive: true,
          }).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
    }

    app.setPath("userData", profile);
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  Menu.setApplicationMenu(null);
  const configPath = join(app.getPath("userData"), "desktop.json");
  let config = await readDesktopConfig(configPath);
  if (!app.isPackaged && process.env.VIBESTAR_DEV_URL && process.env.VIBESTAR_DEV_WSL_CONFIG)
    config = z
      .object({
        distro: z.string().min(1),
        data_home: z.string(),
        helper_path: z.string().min(1),
      })
      .parse(JSON.parse(process.env.VIBESTAR_DEV_WSL_CONFIG));

  const coreDir = app.isPackaged
    ? join(process.resourcesPath, "core")
    : join(app.getAppPath(), "dist-core");

  const startCore = () => {
    bridge = new CoreBridge(coreDir, config);
    bridge.on("event", (event) => window?.webContents.send("core:event", event));
    if (process.platform !== "win32" || config.distro) bridge.start();
  };

  startCore();

  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame)
      throw new Error("Untrusted IPC sender");
  };

  ipcMain.handle("core:rpc", async (event, input) => {
    trusted(event);
    try {
      const p = z.object({ method: z.string().max(100), params: z.unknown() }).parse(input);
      if (!bridge) throw new Error("Core not initialized");
      return { ok: true, result: await bridge.request(p.method, p.params) };
    } catch (error) {
      const failure = error as Error & {
        kind?: string;
        context?: Record<string, unknown>;
        technical?: string;
      };

      return {
        ok: false,
        error: {
          kind: failure.kind || "operation_failed",
          message: failure.message || "The operation could not be completed",
          context: failure.context,
          technical: failure.technical || failure.stack,
        },
      };
    }
  });

  ipcMain.handle("desktop:settings", async (event) => {
    trusted(event);
    let distros: string[] = [];
    if (process.platform === "win32") {
      const o = await exec("wsl.exe", ["--list", "--quiet"], {
        encoding: "buffer",
        windowsHide: true,
      });

      distros = o.stdout
        .toString("utf16le")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else distros = [process.env.WSL_DISTRO_NAME || "Local Linux"];
    return { config, distros, native_windows: process.platform === "win32" };
  });

  ipcMain.handle("desktop:save", async (event, input) => {
    trusted(event);

    const updated = z
      .object({
        distro: z
          .string()
          .max(200)
          .regex(/^[^\x00]*$/),
        data_home: z
          .string()
          .max(4000)
          .refine((s) => !s || s.startsWith("/"), "Use an absolute Linux data directory"),
        helper_path: z
          .string()
          .max(4000)
          .refine((s) => !s || s.startsWith("/"), "Use an absolute Linux helper path"),
      })
      .parse(input);

    if (JSON.stringify(updated) === JSON.stringify(config)) return;
    await bridge?.stop();
    config = updated;
    await saveDesktopConfig(configPath, config);
    startCore();
  });

  ipcMain.handle("desktop:install", async (event) => {
    trusted(event);
    if (!bridge) throw new Error("Save your distro first");
    await bridge.stop();

    await bridge.install((text) =>
      window?.webContents.send("core:event", { event: "install.output", text }),
    );

    startCore();
  });

  ipcMain.handle("desktop:external", async (event, url) => {
    trusted(event);
    const u = new URL(z.string().parse(url));
    if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password)
      throw new Error("Only HTTPS GitHub links may be opened");
    await shell.openExternal(u.href);
  });

  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.max(800, Math.min(1440, area.width - 80));
  const height = Math.max(540, Math.min(940, area.height - 80));

  window = new BrowserWindow({
    title: "akkco vibestar",
    icon: join(app.getAppPath(), "assets", "512x512.png"),
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    minWidth: 800,
    minHeight: 540,
    maximizable: true,
    fullscreenable: true,
    frame: false,
    autoHideMenuBar: true,
    resizable: true,
    backgroundColor: "#181818",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.setMenu(null);
  window.setMenuBarVisibility(false);

  ipcMain.handle("window:minimize", (event) => {
    trusted(event);
    window?.minimize();
  });

  let restoreBounds: Electron.Rectangle | null = null;
  let fallbackMaximized = false;
  let boundsTimer: ReturnType<typeof setTimeout> | undefined;

  const state = () => ({
    maximized: !!window && (window.isMaximized() || fallbackMaximized),
    fullscreen: window?.isFullScreen() ?? false,
  });

  let publishedState: ReturnType<typeof state> | null = null;

  const publishState = () => {
    const current = state();
    if (
      publishedState?.maximized === current.maximized &&
      publishedState.fullscreen === current.fullscreen
    )
      return;
    publishedState = current;
    window?.webContents.send("window:state", current);
  };

  const setFullscreen = (fullscreen: boolean) => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = undefined;
    window?.setFullScreen(fullscreen);
  };

  const toggleMaximize = () => {
    if (!window) return;
    if (window.isFullScreen()) {
      setFullscreen(false);
      return;
    }

    if (boundsTimer) clearTimeout(boundsTimer);
    if (state().maximized) {
      window.unmaximize();
      if (fallbackMaximized && restoreBounds) window.setBounds(restoreBounds);
      fallbackMaximized = false;
      publishState();
      return;
    }

    restoreBounds = window.getBounds();
    const workArea = screen.getDisplayMatching(restoreBounds).workArea;
    window.maximize();
    // WSLg may acknowledge maximize without resizing. Windows owns its native
    // transition and DPI geometry; a timed setBounds would fight that transition.
    if (!isWslg) return;

    boundsTimer = setTimeout(() => {
      if (!window || window.isFullScreen() || window.isMinimized()) return;
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

  ipcMain.handle("window:maximize", (event) => {
    trusted(event);
    toggleMaximize();
  });

  ipcMain.handle("window:fullscreen", (event) => {
    trusted(event);
    if (window) setFullscreen(!window.isFullScreen());
  });

  ipcMain.handle("window:close", (event) => {
    trusted(event);
    window?.close();
  });

  ipcMain.handle("window:is-maximized", (event) => {
    trusted(event);
    return state().maximized;
  });

  ipcMain.handle("window:get-state", (event) => {
    trusted(event);
    return state();
  });

  const pointSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  });

  let dragOrigin: {
    point: { x: number; y: number };
    bounds: Electron.Rectangle;
  } | null = null;

  ipcMain.handle("window:drag-start", (event, input) => {
    trusted(event);
    const point = pointSchema.parse(input);

    dragOrigin =
      window && !state().maximized && !state().fullscreen
        ? { point, bounds: window.getBounds() }
        : null;
  });

  ipcMain.handle("window:drag", (event, input) => {
    trusted(event);
    const point = pointSchema.parse(input);
    if (window && dragOrigin)
      window.setPosition(
        Math.round(dragOrigin.bounds.x + point.x - dragOrigin.point.x),
        Math.round(dragOrigin.bounds.y + point.y - dragOrigin.point.y),
      );
  });

  ipcMain.handle("window:drag-end", (event) => {
    trusted(event);
    dragOrigin = null;
  });

  window.on("maximize", publishState);
  window.on("unmaximize", publishState);
  window.on("enter-full-screen", publishState);
  window.on("leave-full-screen", publishState);
  window.on("resize", publishState);

  window.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F11" && !input.isAutoRepeat) {
      event.preventDefault();
      if (window) setFullscreen(!window.isFullScreen());
    }

    if (input.type === "keyDown" && input.key === "Escape" && window?.isFullScreen()) {
      event.preventDefault();
      setFullscreen(false);
    }
  });

  window.once("closed", () => {
    if (boundsTimer) clearTimeout(boundsTimer);
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-attach-webview", (e) => e.preventDefault());
  if (process.env.VIBESTAR_DEV_URL && !app.isPackaged)
    await window.loadURL(process.env.VIBESTAR_DEV_URL);
  else await window.loadFile(join(app.getAppPath(), "dist", "index.html"));
  if (
    !app.isPackaged &&
    process.env.VIBESTAR_DEV_URL &&
    process.platform === "win32" &&
    process.env.VIBESTAR_DEV_WINDOW_META
  )
    await writeFile(
      process.env.VIBESTAR_DEV_WINDOW_META,
      JSON.stringify({
        handle: window.getNativeWindowHandle().readBigUInt64LE().toString(),
        pid: process.pid,
      }),
    );

  window.on("closed", () => {
    window = null;
  });

  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });

  app.on("window-all-closed", () => app.quit());

  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      quitting = true;
      void bridge?.stop().finally(() => app.quit());
    }
  });

  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  if (!app.isPackaged && process.env.VIBESTAR_DEV_URL)
    createInterface({ input: process.stdin }).on("line", (line) => {
      if (line === "vibestar:quit") app.quit();
    });
};

void main().catch((e) => {
  console.error(e);
  app.quit();
});
