import { useCallback, useEffect, useRef, useState } from "react";

import type { Settings } from "../../lib/types";
import type { DesktopInfo } from "../../../electron/contracts";
import { rpc, errorMessage, subscribe } from "../../lib/api";
import { SettingsSchema } from "../../../backend/domain";

/** Manage settings and auto-save changes independently of visible category. */
export const useSettingsDraft = (settings: Settings | undefined, refresh: () => Promise<void>) => {
  const [value, setValue] = useState(settings);
  const incoming = useRef(settings);
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [installLog, setLog] = useState("");
  const [editors, setEditors] = useState<{ id: string; label: string }[]>([]);

  const pendingSettings = useRef<Settings | null>(null);
  const isSavingSettings = useRef(false);

  const pendingDesktop = useRef<DesktopInfo["config"] | null>(null);
  const isSavingDesktop = useRef(false);
  const desktopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;

    void window.vibestar
      .desktopSettings()
      .then((info) => {
        if (!alive) return;
        setDesktop(info);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });

    void rpc<{ editors: typeof editors }>("editors.list")
      .then((result) => {
        if (alive) setEditors(result.editors);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });

    const subscription = subscribe((event) => {
      if (event.event === "install.output") setLog((log) => (log + event.text).slice(-16000));
    });

    return () => {
      alive = false;
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    if (JSON.stringify(incoming.current) === JSON.stringify(settings)) return;
    incoming.current = settings;

    if (!isSavingSettings.current && !pendingSettings.current) {
      setValue(settings);
    }
  }, [settings]);

  const saveSettings = async (target: Settings) => {
    pendingSettings.current = target;
    if (isSavingSettings.current) return;
    isSavingSettings.current = true;
    setBusy(true);
    setError("");

    try {
      while (pendingSettings.current) {
        const toSave = pendingSettings.current;
        pendingSettings.current = null;
        await rpc("settings.save", toSave);
        await refresh();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      isSavingSettings.current = false;
      setBusy(false);
    }
  };

  const updateValue = (next: Settings) => {
    setValue(next);
    const parsed = SettingsSchema.safeParse(next);

    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(" · ")}: ${i.message}`).join("\n"));
      return;
    }

    void saveSettings(next);
  };

  const flushDesktop = useCallback(async () => {
    if (desktopTimer.current) {
      clearTimeout(desktopTimer.current);
      desktopTimer.current = null;
    }

    if (!pendingDesktop.current) return;
    if (isSavingDesktop.current) return;
    isSavingDesktop.current = true;
    setBusy(true);
    setError("");

    try {
      while (pendingDesktop.current) {
        const toSave = pendingDesktop.current;
        pendingDesktop.current = null;
        await window.vibestar?.saveDesktopSettings?.(toSave);
        await refresh();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      isSavingDesktop.current = false;
      setBusy(false);
    }
  }, [refresh]);

  const updateDesktop = (next: DesktopInfo) => {
    const previousDistro = desktop?.config.distro;
    setDesktop(next);
    pendingDesktop.current = next.config;

    if (previousDistro !== next.config.distro) {
      void flushDesktop();
    } else {
      if (desktopTimer.current) clearTimeout(desktopTimer.current);

      desktopTimer.current = setTimeout(() => {
        void flushDesktop();
      }, 400);
    }
  };

  useEffect(() => {
    return () => {
      if (desktopTimer.current) {
        clearTimeout(desktopTimer.current);
        void flushDesktop();
      }
    };
  }, [flushDesktop]);

  const install = async () => {
    if (!desktop || busy) return;
    setBusy(true);
    setError("");
    try {
      await flushDesktop();
      await window.vibestar.installHelper();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return {
    value,
    setValue: updateValue,
    desktop,
    setDesktop: updateDesktop,
    flush: flushDesktop,
    error,
    busy,
    installLog,
    editors,
    install,
  };
};
