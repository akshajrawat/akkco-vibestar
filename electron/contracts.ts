export interface DesktopSettings {
  distro: string;
  data_home: string;
  helper_path: string;
}
export interface DesktopInfo {
  config: DesktopSettings;
  distros: string[];
  native_windows: boolean;
}
export interface DesktopApi {
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  subscribe: (callback: (event: import("../backend/domain").CoreEvent) => void) => () => void;
  desktopSettings: () => Promise<DesktopInfo>;
  saveDesktopSettings: (config: DesktopSettings) => Promise<void>;
  installHelper: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
}

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
}
export interface ElectronWindowApi {
  manualDragging: boolean;
  beginDrag: (point: { x: number; y: number }) => Promise<void>;
  drag: (point: { x: number; y: number }) => Promise<void>;
  endDrag: () => Promise<void>;
  fullscreen: () => Promise<void>;
  getState: () => Promise<WindowState>;
  onStateChanged: (callback: (state: WindowState) => void) => () => void;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void;
}
