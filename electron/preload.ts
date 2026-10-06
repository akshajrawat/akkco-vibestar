import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, ElectronWindowApi } from "./contracts";
const api: DesktopApi = {
  rpc: (method, params = {}) =>
    ipcRenderer.invoke("core:rpc", { method, params }),
  subscribe: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: Parameters<typeof callback>[0],
    ) => callback(payload);
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
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onMaximizedChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
      callback(maximized);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
};
contextBridge.exposeInMainWorld("electronWindow", windowApi);
