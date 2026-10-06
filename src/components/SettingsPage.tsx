import { useEffect, useState } from "react";
import type { Settings } from "../lib/types";
import type { DesktopInfo } from "../../electron/contracts";
import { useProviders } from "../lib/useWorkspace";
import { rpc, errorMessage, subscribe } from "../lib/api";
import { Button } from "./ui/button";
import { StageSettings } from "./StageSettings";
export const SettingsPage = ({
  settings,
  root,
  refresh,
}: {
  settings?: Settings;
  root?: string;
  refresh: () => Promise<void>;
}) => {
  const [value, setValue] = useState(settings);
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [installLog, setLog] = useState("");
  const { providers } = useProviders();
  useEffect(() => {
    void window.vibestar
      .desktopSettings()
      .then(setDesktop)
      .catch((e) => setError(errorMessage(e)));
    const subscription = subscribe((e) => {
      if (e.event === "install.output")
        setLog((s) => (s + e.text).slice(-16000));
    });
    return () => {
      void subscription.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    setValue(settings);
  }, [settings]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (desktop) await window.vibestar.saveDesktopSettings(desktop.config);
      if (value) await rpc("settings.save", value);
      setNotice("Settings saved.");
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">LOCAL EXECUTION CONFIGURATION</span>
          <h1>Settings</h1>
        </div>
        <Button variant="default" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <section className="settings-section">
        <h2>Execution environment</h2>
        <div className="settings-fields">
          <label>
            WSL distribution
            <select
              value={desktop?.config.distro || desktop?.distros[0] || ""}
              disabled={!desktop?.native_windows}
              onChange={(e) =>
                desktop &&
                setDesktop({
                  ...desktop,
                  config: { ...desktop.config, distro: e.target.value },
                })
              }
            >
              {desktop?.native_windows && (
                <option value="">Select distribution</option>
              )}
              {desktop?.distros.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Linux data directory <span className="subtle">optional</span>
            <input
              value={desktop?.config.data_home || ""}
              placeholder="Default: ~/.akkco-ade"
              onChange={(e) =>
                desktop &&
                setDesktop({
                  ...desktop,
                  config: { ...desktop.config, data_home: e.target.value },
                })
              }
            />
          </label>
          {desktop?.native_windows && (
            <label>
              Existing helper path <span className="subtle">optional</span>
              <input
                value={desktop.config.helper_path}
                placeholder="Use the installed bundled helper"
                onChange={(e) =>
                  setDesktop({
                    ...desktop,
                    config: { ...desktop.config, helper_path: e.target.value },
                  })
                }
              />
            </label>
          )}
          <label>
            Current local data root
            <code>{root || "Execution core not connected"}</code>
          </label>
        </div>
        {desktop?.native_windows && (
          <>
            <Button
              disabled={busy || !desktop.config.distro}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await window.vibestar.saveDesktopSettings(desktop.config);
                  await window.vibestar.installHelper();
                  await refresh();
                  setNotice("WSL helper installed.");
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Install / update WSL helper
            </Button>
            <p className="subtle">
              Installs the bundled core and native SQLite/PTY dependencies
              inside the selected distro. Requires Node 22+, npm, and build
              tools there.
            </p>
            {installLog && <pre className="install-log">{installLog}</pre>}
          </>
        )}
        <p className="subtle">
          Linux builds execute directly inside the current distro. Windows
          builds invoke the chosen distro with structured argv and stdin.
        </p>
      </section>
      {value && (
        <>
          <section className="settings-section">
            <h2>Concurrency</h2>
            <label>
              Simultaneous tasks
              <select
                value={value.concurrency}
                onChange={(e) =>
                  setValue({ ...value, concurrency: Number(e.target.value) })
                }
              >
                {[1, 2, 3, 4].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </section>
          <section className="settings-section">
            <h2>Agent stages</h2>
            <p className="subtle">
              Models and reasoning settings are independent. Empty model uses
              that CLI’s default; requested models and effort are never silently
              substituted.
            </p>
            <StageSettings
              settings={value}
              onChange={setValue}
              providers={providers}
            />
          </section>
        </>
      )}
    </div>
  );
};
