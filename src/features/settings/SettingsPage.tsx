import { useEffect, useRef, useState } from "react";
import type { Settings, Snapshot } from "../../lib/types";
import type { DesktopInfo } from "../../../electron/contracts";
import { useProviders } from "../../hooks/useWorkspace";
import { rpc, errorMessage, subscribe } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { StageSettings, AgentConfiguration } from "../providers/StageSettings";
import { StoragePage } from "./StoragePage";
import { DiscoverySettings } from "./DiscoverySettings";
import { UsageView } from "../usage/UsageView";
import { PageHeader } from "../../components/ui/PageHeader";
import { SettingsSchema } from "../../../backend/domain";
export const SettingsPage = ({
  settings,
  root,
  refresh,
  diagnostics,
}: {
  settings?: Settings;
  root?: string;
  refresh: () => Promise<void>;
  diagnostics?: Snapshot["persistence"];
}) => {
  const [value, setValue] = useState(settings);
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  const [savedDesktop, setSavedDesktop] = useState<DesktopInfo["config"]>();
  const settingsBaseline = useRef(settings);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [installLog, setLog] = useState("");
  const [editors, setEditors] = useState<{ id: string; label: string }[]>([]);
  const [section, setSection] = useState("Agents");
  const { providers } = useProviders();
  useEffect(() => {
    void window.vibestar
      .desktopSettings()
      .then((info) => {
        setDesktop(info);
        setSavedDesktop(info.config);
      })
      .catch((e) => setError(errorMessage(e)));
    const subscription = subscribe((e) => {
      if (e.event === "install.output") setLog((s) => (s + e.text).slice(-16000));
    });
    return () => {
      void subscription.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    void rpc<{ editors: typeof editors }>("editors.list")
      .then((r) => setEditors(r.editors))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    const previous = settingsBaseline.current;
    settingsBaseline.current = settings;
    setValue((current) =>
      JSON.stringify(current) === JSON.stringify(previous) ? settings : current,
    );
  }, [settings]);
  useEffect(() => {
    setNotice("");
  }, [value, desktop?.config]);
  const dirty =
    JSON.stringify(value) !== JSON.stringify(settings) ||
    JSON.stringify(desktop?.config) !== JSON.stringify(savedDesktop);
  const validation = value && SettingsSchema.safeParse(value);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (desktop) await window.vibestar.saveDesktopSettings(desktop.config);
      if (value) await rpc("settings.save", value);
      setSavedDesktop(desktop?.config);
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
      {!!diagnostics?.length && (
        <details className="error-box" open>
          <summary>Saved records need recovery</summary>
          <p>
            Original record data remains in SQLite. Affected workspace actions are blocked. Preserve
            the data root and its pre-migration backups before repairing these records.
          </p>
          <ul>
            {diagnostics.map((record) => (
              <li key={`${record.table_name}:${record.record_id}:${record.column_name}`}>
                <code>
                  {record.table_name} · {record.record_id} · {record.column_name}
                </code>
                <small>Source SHA-256: {record.source_hash}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
      <PageHeader
        title="Settings"
        description="Configure your workspace, agent stages and execution environment."
        actions={
          <>
            <span className="settings-save-state" role="status">
              {dirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <Button
              variant="default"
              busy={busy}
              disabled={!dirty || (!!validation && !validation.success)}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save settings"}
            </Button>
          </>
        }
      />
      {validation && !validation.success && (
        <p className="error-box" role="alert">
          {validation.error.issues
            .map((issue) => `${issue.path.join(" · ")}: ${issue.message}`)
            .join("\n")}
        </p>
      )}
      {error && <div className="error-box">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {[
            "General",
            "Agents",
            "Models",
            "GitHub & PR Watch",
            "Repositories",
            "Storage",
            "Usage",
            "Execution",
          ].map((name) => (
            <button
              type="button"
              key={name}
              className={section === name ? "selected" : ""}
              aria-current={section === name ? "page" : undefined}
              onClick={() => {
                setSection(name);
                setNotice("");
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "Execution" && (
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
                    {desktop?.native_windows && <option value="">Select distribution</option>}
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
                    placeholder="Default: ~/.akkco-vibestar"
                    onChange={(e) =>
                      desktop &&
                      setDesktop({
                        ...desktop,
                        config: {
                          ...desktop.config,
                          data_home: e.target.value,
                        },
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
                          config: {
                            ...desktop.config,
                            helper_path: e.target.value,
                          },
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
                    Installs the bundled core and native SQLite/PTY dependencies inside the selected
                    distro. Requires Node 22+, npm, and build tools there.
                  </p>
                  {installLog && <pre className="install-log">{installLog}</pre>}
                </>
              )}
              <p className="subtle">
                Linux builds execute directly inside the current distro. Windows builds invoke the
                chosen distro with structured argv and stdin.
              </p>
            </section>
          )}
          {value && (
            <>
              {section === "General" && (
                <section className="settings-section">
                  <h2>Editor</h2>
                  <label>
                    Default editor
                    <select
                      aria-label="Default editor"
                      value={value.default_editor}
                      onChange={(e) =>
                        setValue({
                          ...value,
                          default_editor: e.target.value as Settings["default_editor"],
                        })
                      }
                    >
                      <option value="">Choose when opening</option>
                      {editors.map((editor) => (
                        <option key={editor.id} value={editor.id}>
                          {editor.label}
                        </option>
                      ))}
                      {!!value.default_editor &&
                        !editors.some((e) => e.id === value.default_editor) && (
                          <option value={value.default_editor}>
                            {value.default_editor} (unavailable)
                          </option>
                        )}
                    </select>
                  </label>
                  <p className="subtle">
                    Task actions open the isolated worktree. Repository actions open the source
                    checkout.
                  </p>
                  <h2>Concurrency</h2>
                  <label>
                    Simultaneous tasks
                    <select
                      value={value.concurrency}
                      onChange={(e) =>
                        setValue({
                          ...value,
                          concurrency: Number(e.target.value),
                        })
                      }
                    >
                      {[1, 2, 3, 4].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                </section>
              )}
              {section === "Agents" && (
                <section className="settings-section">
                  <h2>Agent pipeline</h2>
                  <p className="pipeline-sequence">
                    Antigravity Plan → Codex Refinement → Codex Implementation → Antigravity Review
                  </p>
                  <p className="subtle">
                    Models and reasoning settings are independent. Empty model uses that CLI’s
                    default; requested models and effort are never silently substituted.
                  </p>
                  <StageSettings settings={value} onChange={setValue} providers={providers} />
                </section>
              )}
              {section === "Models" && (
                <section className="settings-section">
                  <h2>Review / explain AI</h2>
                  <p className="subtle">
                    Read-only questions about selected code. Each query appears in task and global
                    Usage.
                  </p>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={!!value.review_ai}
                      onChange={(e) =>
                        setValue({
                          ...value,
                          review_ai: e.target.checked ? { ...value.utility_ai } : null,
                        })
                      }
                    />
                    Use a separate review model
                  </label>
                  {value.review_ai ? (
                    <>
                      <label>
                        Review provider
                        <select
                          value={value.review_ai.provider}
                          onChange={(e) =>
                            setValue({
                              ...value,
                              review_ai: {
                                ...value.review_ai!,
                                provider: e.target.value as "codex" | "antigravity",
                                model: "",
                              },
                            })
                          }
                        >
                          <option value="antigravity">Antigravity</option>
                          <option value="codex">Codex</option>
                        </select>
                      </label>
                      <AgentConfiguration
                        id="review-ai"
                        label="REVIEW / EXPLAIN AI"
                        provider={value.review_ai.provider}
                        providers={providers}
                        config={value.review_ai}
                        onChange={(config) =>
                          setValue({
                            ...value,
                            review_ai: {
                              ...config,
                              provider: value.review_ai!.provider,
                            },
                          })
                        }
                      />
                    </>
                  ) : (
                    <p className="subtle">
                      Uses Utility AI settings. Individual questions can override provider, model
                      and effort.
                    </p>
                  )}
                  <h2>Utility AI</h2>
                  <p className="subtle">
                    PR discussion reasoning and miscellaneous Vibestar intelligence. Deterministic
                    inspections never use this model. Each run appears in Usage.
                  </p>
                  <label>
                    Utility provider
                    <select
                      value={value.utility_ai.provider}
                      onChange={(e) =>
                        setValue({
                          ...value,
                          utility_ai: {
                            ...value.utility_ai,
                            provider: e.target.value as Settings["utility_ai"]["provider"],
                            model: "",
                          },
                        })
                      }
                    >
                      <option value="antigravity">Antigravity</option>
                      <option value="codex">Codex</option>
                    </select>
                  </label>
                  <AgentConfiguration
                    id="utility"
                    label="UTILITY / MISCELLANEOUS AI"
                    provider={value.utility_ai.provider}
                    providers={providers}
                    config={value.utility_ai}
                    onChange={(config) =>
                      setValue({
                        ...value,
                        utility_ai: {
                          ...config,
                          provider: value.utility_ai.provider,
                        },
                      })
                    }
                  />
                </section>
              )}
              {section === "Repositories" && (
                <DiscoverySettings
                  value={value.repository_discovery}
                  onChange={(repository_discovery) => setValue({ ...value, repository_discovery })}
                />
              )}
            </>
          )}
          {section === "Storage" && <StoragePage refresh={refresh} />}
          {section === "Usage" && <UsageView />}
          {section === "GitHub & PR Watch" && (
            <section className="settings-section">
              <h2>GitHub & PR review</h2>
              <p>
                PR inspection is manual only. Refresh PR List reads GitHub metadata; opening a
                discovered PR saves its workspace. Only Analyze PR can request semantic review
                analysis.
              </p>
              <p className="subtle">
                Automatic watches, recurring inspections and legacy optional second-model
                verification are disabled. Existing PR history and usage are preserved. Configure
                the analysis provider/model under Models → Utility AI.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};
