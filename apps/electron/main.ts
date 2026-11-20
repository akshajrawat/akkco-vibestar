import { app, BrowserWindow, ipcMain, shell, Menu, screen, dialog } from "electron";
import { mkdir, writeFile, cp, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { z } from "zod";
import { CoreBridge, readDesktopConfig, saveDesktopConfig } from "./bridge";
import { configureWindowControls } from "./window-controls";

const exec = promisify(execFile);
const isWslg = process.platform === "linux" && !!process.env.WSL_DISTRO_NAME;
// WSLg exposes Xwayland window geometry; Wayland does not guarantee positioning.
if (isWslg) {
  app.commandLine.appendSwitch("ozone-platform", "x11");
}

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
            if (error.code !== "ENOENT") {
              throw error;
            }
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
  let changingRuntime = false;
  if (!app.isPackaged && process.env.VIBESTAR_DEV_URL && process.env.VIBESTAR_DEV_WSL_CONFIG) {
    config = z
      .object({
        distro: z.string().min(1),
        data_home: z.string(),
        helper_path: z.string().min(1),
      })
      .parse(JSON.parse(process.env.VIBESTAR_DEV_WSL_CONFIG));
  }

  const coreDir = app.isPackaged
    ? join(process.resourcesPath, "core")
    : join(app.getAppPath(), "out", "core");

  const startCore = () => {
    bridge = new CoreBridge(coreDir, config);
    bridge.on("event", (event) => window?.webContents.send("core:event", event));
    if (process.platform !== "win32" || config.distro) {
      void bridge.start();
    }
  };

  startCore();

  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    const sender = window;
    if (
      !sender ||
      event.sender !== sender.webContents ||
      event.senderFrame !== sender.webContents.mainFrame
    ) {
      throw new Error("Untrusted IPC sender");
    }

    return sender;
  };

  ipcMain.handle("core:rpc", async (event, input) => {
    trusted(event);
    try {
      const p = z.object({ method: z.string().max(100), params: z.unknown() }).parse(input);
      if (!bridge) {
        throw new Error("Core not initialized");
      }

      if (changingRuntime) {
        throw new Error("The runtime is restarting. Retry when it is ready.");
      }

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
    } else {
      distros = [process.env.WSL_DISTRO_NAME || "Local Linux"];
    }

    return {
      config,
      distros,
      native_windows: process.platform === "win32",
      runtime_status: bridge?.runtimeStatus,
    };
  });

  ipcMain.handle("desktop:save", async (event, input) => {
    const sender = trusted(event);

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

    if (JSON.stringify(updated) === JSON.stringify(config)) {
      return true;
    }

    if (changingRuntime) {
      throw new Error("A runtime change is already in progress.");
    }

    changingRuntime = true;
    try {
      const answer = await dialog.showMessageBox(sender, {
        type: "question",
        title: "Restart execution environment?",
        message: "Save these environment changes and restart the backend?",
        detail:
          "Running Viber sessions and terminals must finish first. Your selected WSL distribution will only change if you chose a different one here.",
        buttons: ["Cancel", "Save and restart"],
        defaultId: 0,
        cancelId: 0,
      });

      if (answer.response !== 1) {
        return false;
      }

      await bridge?.prepareRestart();
      await bridge?.stop();
      try {
        await saveDesktopConfig(configPath, updated);
        config = updated;
      } finally {
        startCore();
      }

      return true;
    } finally {
      changingRuntime = false;
    }
  });

  ipcMain.handle("desktop:install", async (event) => {
    trusted(event);
    if (!bridge) {
      throw new Error("Save your distro first");
    }

    if (changingRuntime) {
      throw new Error("A runtime change is already in progress.");
    }

    changingRuntime = true;
    try {
      await bridge.repair();
    } finally {
      changingRuntime = false;
    }
  });

  ipcMain.handle("desktop:retry", async (event) => {
    trusted(event);
    if (!bridge) {
      throw new Error("Core not initialized");
    }

    if (changingRuntime) {
      throw new Error("A runtime change is already in progress.");
    }

    changingRuntime = true;
    try {
      await bridge.retry();
    } finally {
      changingRuntime = false;
    }
  });

  ipcMain.handle("desktop:external", async (event, url) => {
    trusted(event);
    const u = new URL(z.string().parse(url));
    if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password) {
      throw new Error("Only HTTPS GitHub links may be opened");
    }

    await shell.openExternal(u.href);
  });

  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.max(800, Math.min(1440, area.width - 80));
  const height = Math.max(540, Math.min(940, area.height - 80));

  window = new BrowserWindow({
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    title: "akkco vibestar",
    icon: join(app.getAppPath(), "assets", "512x512.png"),
    minWidth: 800,
    minHeight: 540,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b0b0b",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const controls = configureWindowControls(window, isWslg);

  const windowControls = (event: Electron.IpcMainInvokeEvent) => {
    trusted(event);
    return controls;
  };

  ipcMain.handle("window:minimize", (event) => windowControls(event).minimize());
  ipcMain.handle("window:maximize", (event) => windowControls(event).maximize());
  ipcMain.handle("window:fullscreen", (event) => windowControls(event).fullscreen());
  ipcMain.handle("window:close", (event) => windowControls(event).close());
  ipcMain.handle("window:get-state", (event) => windowControls(event).state());
  ipcMain.handle("window:drag-start", (event, input) => windowControls(event).dragStart(input));
  ipcMain.handle("window:drag", (event, input) => windowControls(event).drag(input));
  ipcMain.handle("window:drag-end", (event) => windowControls(event).dragEnd());

  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  if (process.env.VIBESTAR_DEV_URL && !app.isPackaged) {
    await window.loadURL(process.env.VIBESTAR_DEV_URL);
  } else {
    await window.loadFile(join(app.getAppPath(), "out", "desktop", "index.html"));
  }

  window.once("closed", () => {
    window = null;
  });

  if (
    !app.isPackaged &&
    process.env.VIBESTAR_DEV_URL &&
    process.platform === "win32" &&
    process.env.VIBESTAR_DEV_WINDOW_META
  ) {
    await writeFile(
      process.env.VIBESTAR_DEV_WINDOW_META,
      JSON.stringify({
        handle: window.getNativeWindowHandle().readBigUInt64LE().toString(),
        pid: process.pid,
      }),
    );
  }

  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });

  app.on("window-all-closed", () => app.quit());

  app.on("will-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      quitting = true;
      void Promise.resolve(bridge?.stop()).finally(() => app.quit());
    }
  });

  const closeApp = () => (window ? window.close() : app.quit());
  process.once("SIGTERM", closeApp);
  process.once("SIGINT", closeApp);
  if (!app.isPackaged && process.env.VIBESTAR_DEV_URL) {
    createInterface({ input: process.stdin }).on("line", (line) => {
      if (line === "vibestar:quit") {
        closeApp();
      }
    });
  }
};

void main().catch((e) => {
  console.error(e);
  app.quit();
});
