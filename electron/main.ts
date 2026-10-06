import { app, BrowserWindow, ipcMain, shell, Menu } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { CoreBridge, readDesktopConfig, saveDesktopConfig } from "./bridge";
const exec = promisify(execFile);
let window: BrowserWindow | null = null;
let bridge: CoreBridge | null = null;
let quitting = false;
const main = async () => {
  if (!app.isPackaged && process.env.VIBESTAR_USER_DATA) {
    await mkdir(process.env.VIBESTAR_USER_DATA, { recursive: true });
    app.setPath("userData", process.env.VIBESTAR_USER_DATA);
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  Menu.setApplicationMenu(null);
  const configPath = join(app.getPath("userData"), "desktop.json");
  let config = await readDesktopConfig(configPath);
  const coreDir = app.isPackaged
    ? join(process.resourcesPath, "core")
    : join(app.getAppPath(), "dist-core");
  const startCore = () => {
    bridge = new CoreBridge(coreDir, config);
    bridge.on("event", (event) =>
      window?.webContents.send("core:event", event),
    );
    if (process.platform !== "win32" || config.distro) bridge.start();
  };
  startCore();
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== window?.webContents ||
      event.senderFrame !== window?.webContents.mainFrame
    )
      throw new Error("Untrusted IPC sender");
  };
  ipcMain.handle("core:rpc", (event, input) => {
    trusted(event);
    const p = z
      .object({ method: z.string().max(100), params: z.unknown() })
      .parse(input);
    if (!bridge) throw new Error("Core not initialized");
    return bridge.request(p.method, p.params);
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
          .refine(
            (s) => !s || s.startsWith("/"),
            "Use an absolute Linux data directory",
          ),
        helper_path: z
          .string()
          .max(4000)
          .refine(
            (s) => !s || s.startsWith("/"),
            "Use an absolute Linux helper path",
          ),
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
    if (
      u.protocol !== "https:" ||
      u.hostname !== "github.com" ||
      u.username ||
      u.password
    )
      throw new Error("Only HTTPS GitHub links may be opened");
    await shell.openExternal(u.href);
  });
  window = new BrowserWindow({
    title: "akkco vibestar",
    icon: join(app.getAppPath(), "assets", "512x512.png"),
    width: 1440,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    frame: false,
    autoHideMenuBar: true,
    resizable: true,
    backgroundColor: "#101217",
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
  ipcMain.handle("window:maximize", (event) => {
    trusted(event);
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
  });
  ipcMain.handle("window:close", (event) => {
    trusted(event);
    window?.close();
  });
  ipcMain.handle("window:is-maximized", (event) => {
    trusted(event);
    return window?.isMaximized() ?? false;
  });
  const windowState = () =>
    window?.webContents.send("window:state", window.isMaximized());
  window.on("maximize", windowState);
  window.on("unmaximize", windowState);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-attach-webview", (e) => e.preventDefault());
  if (process.env.VIBESTAR_DEV_URL && !app.isPackaged)
    await window.loadURL(process.env.VIBESTAR_DEV_URL);
  else await window.loadFile(join(app.getAppPath(), "dist", "index.html"));
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
};
void main().catch((e) => {
  console.error(e);
  app.quit();
});
