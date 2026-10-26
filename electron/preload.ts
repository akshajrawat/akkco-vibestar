import { contextBridge, ipcRenderer } from "electron";

import type { DesktopApi, ElectronWindowApi } from "./contracts";

const api: DesktopApi = {
  rpc: async (method, params = {}) => {
    const response = await ipcRenderer.invoke("core:rpc", { method, params });
    if (!response.ok) throw response.error;
    return response.result;
  },
  subscribe: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) =>
      callback(payload);

    ipcRenderer.on("core:event", listener);
    return () => ipcRenderer.removeListener("core:event", listener);
  },
  desktopSettings: () => ipcRenderer.invoke("desktop:settings"),
  saveDesktopSettings: (config) => ipcRenderer.invoke("desktop:save", config),
  installHelper: () => ipcRenderer.invoke("desktop:install"),
  openExternal: (url) => ipcRenderer.invoke("desktop:external", url),
};

contextBridge.exposeInMainWorld("vibestar", api);

const windowApi: ElectronWindowApi = {
  manualDragging: process.platform === "linux" && !!process.env.WSL_DISTRO_NAME,
  beginDrag: (point) => ipcRenderer.invoke("window:drag-start", point),
  drag: (point) => ipcRenderer.invoke("window:drag", point),
  endDrag: () => ipcRenderer.invoke("window:drag-end"),
  fullscreen: () => ipcRenderer.invoke("window:fullscreen"),
  getState: () => ipcRenderer.invoke("window:get-state"),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) =>
      callback(state);

    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizedChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { maximized: boolean }) =>
      callback(state.maximized);

    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
};

contextBridge.exposeInMainWorld("electronWindow", windowApi);
