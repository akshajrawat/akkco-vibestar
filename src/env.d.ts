import type { DesktopApi, ElectronWindowApi } from "../electron/contracts";
declare global {
  interface Window {
    vibestar: DesktopApi;
    electronWindow: ElectronWindowApi;
    MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker };
  }
}
export {};
