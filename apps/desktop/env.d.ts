import type { DesktopApi, ElectronWindowApi } from "../electron/contracts";

declare global {
  interface Window {
    vibestar: DesktopApi;
    electronWindow: ElectronWindowApi;
  }
}
export {};
