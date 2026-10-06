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
  subscribe: (
    callback: (event: import("../backend/domain").CoreEvent) => void,
  ) => () => void;
  desktopSettings: () => Promise<DesktopInfo>;
  saveDesktopSettings: (config: DesktopSettings) => Promise<void>;
  installHelper: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
}

export interface ElectronWindowApi {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void;
}
