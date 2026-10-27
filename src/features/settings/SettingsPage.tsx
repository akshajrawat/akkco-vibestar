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
import { Select } from "../../components/ui/Select";
import { ProviderIcon } from "../../components/ui/ProviderIcon";

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
  const [section, setSection] = useState("Agents & Models");
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
          {["General", "Agents & Models", "Repositories", "Storage", "Usage", "Execution"].map(
            (name) => (
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
            ),
          )}
        </nav>

        <div className="settings-content">
          {section === "Execution" && (
            <section className="settings-section execution-settings">
              <h2>Execution environment</h2>
              <div className="settings-fields">
                <label>
                  WSL distribution
                  <Select
                    label="WSL distribution"
                    value={desktop?.config.distro || desktop?.distros[0] || ""}
                    disabled={!desktop?.native_windows}
                    onChange={(distro) =>
                      desktop &&
                      setDesktop({
                        ...desktop,
                        config: { ...desktop.config, distro },
                      })
                    }
                    options={[
                      ...(desktop?.native_windows
                        ? [{ value: "", label: "Select distribution" }]
                        : []),
                      ...(desktop?.distros.map((d) => ({ value: d, label: d })) || []),
                    ]}
                  />
                </label>

                <label>
                  <span>
                    Linux data directory <small>optional</small>
                  </span>
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
                    <span>
                      Existing helper path <small>optional</small>
                    </span>
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
              </div>

              <details>
                <summary>Execution details</summary>
                <p className="subtle">
                  Data root: <code>{root || "Execution core not connected"}</code>
                </p>
                <p className="subtle">
                  Linux runs the core directly. Windows uses the selected WSL distribution.
                </p>
              </details>

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
            </section>
          )}

          {value && (
            <>
              {section === "General" && (
                <section className="settings-section">
                  <h2>Editor</h2>
                  <label>
                    Default editor
                    <Select
                      label="Default editor"
                      value={value.default_editor}
                      onChange={(editor) =>
                        setValue({
                          ...value,
                          default_editor: editor as Settings["default_editor"],
                        })
                      }
                      options={[
                        { value: "", label: "Choose when opening" },
                        ...editors.map((editor) => ({ value: editor.id, label: editor.label })),
                        ...(value.default_editor &&
                        !editors.some((e) => e.id === value.default_editor)
                          ? [
                              {
                                value: value.default_editor,
                                label: `${value.default_editor} (unavailable)`,
                              },
                            ]
                          : []),
                      ]}
                    />
                  </label>

                  <p className="subtle">
                    Task actions open the isolated worktree. Repository actions open the source
                    checkout.
                  </p>
                  <h2>Concurrency</h2>
                  <label>
                    Simultaneous tasks
                    <Select
                      label="Simultaneous tasks"
                      value={String(value.concurrency)}
                      onChange={(concurrency) =>
                        setValue({
                          ...value,
                          concurrency: Number(concurrency),
                        })
                      }
                      options={[1, 2, 3, 4].map((v) => ({ value: String(v), label: String(v) }))}
                    />
                  </label>
                </section>
              )}

              {section === "Agents & Models" && (
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

              {section === "Agents & Models" && (
                <section className="settings-section">
                  <h2>Review / explain AI</h2>
                  <p className="subtle">
                    Read-only questions about selected code. Each query appears in task and global
                    Usage.
                  </p>

                  <label className="checkbox-label">
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
                        <Select
                          label="Review provider"
                          value={value.review_ai.provider}
                          onChange={(provider) =>
                            setValue({
                              ...value,
                              review_ai: {
                                ...value.review_ai!,
                                provider: provider as "codex" | "antigravity",
                                model: "",
                              },
                            })
                          }
                          options={["antigravity", "codex"].map((provider) => ({
                            value: provider,
                            label: provider === "codex" ? "Codex" : "Antigravity",
                            icon: <ProviderIcon provider={provider} />,
                          }))}
                        />
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
                    <Select
                      label="Utility provider"
                      value={value.utility_ai.provider}
                      onChange={(provider) =>
                        setValue({
                          ...value,
                          utility_ai: {
                            ...value.utility_ai,
                            provider: provider as Settings["utility_ai"]["provider"],
                            model: "",
                          },
                        })
                      }
                      options={["antigravity", "codex"].map((provider) => ({
                        value: provider,
                        label: provider === "codex" ? "Codex" : "Antigravity",
                        icon: <ProviderIcon provider={provider} />,
                      }))}
                    />
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
        </div>
      </div>
    </div>
  );
};
