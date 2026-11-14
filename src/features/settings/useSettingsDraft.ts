import { useEffect, useRef, useState } from "react";

import type { Settings } from "../../lib/types";
import type { DesktopInfo } from "../../../electron/contracts";
import { rpc, errorMessage, subscribe } from "../../lib/api";
import { notifications } from "../../lib/notifications";
import { SettingsSchema, defaultSettings } from "../../../backend/domain";
import { useAutosave } from "./useAutosave";

/** Settings remain optimistic only until their serialized persistence result arrives. */
export const useSettingsDraft = (settings: Settings | undefined, refresh: () => Promise<void>) => {
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installLog, setLog] = useState("");
  const [editors, setEditors] = useState<{ id: string; label: string }[]>([]);
  const desktopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const core = useAutosave(
    settings || defaultSettings,
    async (value) => {
      await rpc("settings.save", value);

      void refresh().catch((error) =>
        notifications.error(errorMessage(error), { id: "settings:refresh" }),
      );
    },
    "settings",
    (value) => notifications.setPreference(value.notification_preference),
  );

  const environment = useAutosave<DesktopInfo["config"]>(
    { distro: "", data_home: "", helper_path: "" },
    async (config) => {
      const saved = await window.vibestar.saveDesktopSettings(config);
      if (saved === false) throw { kind: "cancelled", message: "Environment change cancelled" };

      void refresh().catch((error) =>
        notifications.error(errorMessage(error), { id: "settings:refresh" }),
      );
    },
    "execution settings",
  );

  const receiveSettings = core.receive;

  useEffect(() => {
    if (settings) receiveSettings(settings);
    // Incoming snapshots are reconciled only when their values actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  useEffect(() => {
    let alive = true;

    const loadDesktop = () => {
      void window.vibestar
        .desktopSettings()
        .then((info) => {
          if (!alive) return;
          setDesktop(info);
          environment.receive(info.config);
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    };

    const loadEditors = () => {
      void rpc<{ editors: typeof editors }>("editors.list")
        .then((result) => {
          if (alive) setEditors(result.editors);
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    };

    loadDesktop();
    loadEditors();

    const subscription = subscribe((event) => {
      if (event.event === "install.output") setLog((log) => (log + event.text).slice(-16000));
      if (
        event.event === "runtime.status" &&
        (event.data as { phase?: string })?.phase === "ready"
      ) {
        setError("");
        loadDesktop();
        loadEditors();
      }
    });

    return () => {
      alive = false;
      void subscription.then((unsubscribe) => unsubscribe());
    };
    // Load desktop metadata once; autosave owns subsequent config changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushDesktop = () => {
    if (desktopTimer.current) clearTimeout(desktopTimer.current);
    desktopTimer.current = null;
    return environment.flush();
  };

  const flushRef = useRef(flushDesktop);
  flushRef.current = flushDesktop;

  useEffect(
    () => () => {
      void flushRef.current();
    },
    [],
  );

  return {
    value: settings ? core.value : undefined,
    setValue: (next: Settings) => {
      const parsed = SettingsSchema.safeParse(next);
      if (!parsed.success) {
        notifications.error(parsed.error.issues.map((issue) => issue.message).join("\n"), {
          id: "settings:validation",
        });

        return;
      }

      core.update(parsed.data);
      void core.flush();
    },
    desktop: desktop ? { ...desktop, config: environment.value } : null,
    setDesktop: (next: DesktopInfo) => {
      environment.update(next.config);
      if (desktopTimer.current) clearTimeout(desktopTimer.current);

      desktopTimer.current = setTimeout(() => {
        void flushDesktop();
      }, 400);
    },
    flush: flushDesktop,
    error,
    busy: core.busy || environment.busy || installing,
    installLog,
    editors,
    install: async () => {
      if (installing) return;
      setInstalling(true);
      try {
        await window.vibestar.installHelper();
        await refresh();
      } catch (e) {
        notifications.error(errorMessage(e), {
          id: "runtime",
          action: { label: "Retry", run: () => window.vibestar.retryRuntime() },
        });
      } finally {
        setInstalling(false);
      }
    },
  };
};
