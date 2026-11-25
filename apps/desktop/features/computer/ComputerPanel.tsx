import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Folder, Monitor, RotateCw, TerminalSquare, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { computerRpc, errorMessage, subscribe } from "../../lib/api";
import type { ComputerFiles, ComputerRpc, ComputerStatus } from "../../../core/computers/contracts";
import { ComputerDesktop } from "./ComputerDesktop";
import { ComputerTerminal } from "./ComputerTerminal";

const labels = { starting: "Starting", ready: "Ready", stopped: "Stopped", error: "Error" };

const tabs = [
  { id: "desktop", label: "Desktop", Icon: Monitor },
  { id: "terminal", label: "Terminal", Icon: TerminalSquare },
  { id: "files", label: "Files", Icon: Folder },
] as const;

type Tab = (typeof tabs)[number]["id"];

export const ComputerPanel = ({
  supported,
  status,
  refresh,
  hide,
  settings,
}: {
  supported: boolean;
  status?: ComputerStatus;
  refresh: () => void;
  hide: () => void;
  settings: () => void;
}) => {
  const [tab, setTab] = useState<Tab>("desktop");
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(false);
  const [error, setError] = useState("");
  const [shell, setShell] = useState<string>();
  const [path, setPath] = useState("");
  const [files, setFiles] = useState<ComputerFiles>();
  const owned = useRef(true);
  const ready = status?.status === "ready";
  const canRead = status?.has_data && (ready || status.status === "stopped");

  useEffect(() => {
    owned.current = true;
    return () => {
      owned.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready || tab !== "terminal") {
      return;
    }

    let active = true;
    let generation = 0;

    const load = async () => {
      const requested = ++generation;
      try {
        const current = await computerRpc("computer.terminal.status", {});
        if (active && requested === generation) {
          setShell(current?.id);
        }
      } catch (reason) {
        if (active && requested === generation) {
          setShell(undefined);
          setError(errorMessage(reason));
        }
      }
    };

    const subscription = subscribe((event) => {
      if (!active) {
        return;
      }

      if (event.event === "computer.terminal.opened") {
        generation++;
        setShell(event.session_id);
      } else if (event.event === "computer.terminal.closed") {
        generation++;
        setShell((current) => (current === event.session_id ? undefined : current));
      } else if (event.event === "core.closed" || event.event === "core.error") {
        generation++;
        setShell(undefined);
      } else if (
        event.event === "runtime.status" &&
        (event.data as { phase?: string })?.phase === "ready"
      ) {
        void load();
      }
    });

    void subscription.then(load).catch((reason) => {
      if (active) {
        setError(errorMessage(reason));
      }
    });

    return () => {
      active = false;
      void subscription.then((unsubscribe) => unsubscribe()).catch(() => undefined);
    };
  }, [ready, tab]);

  useEffect(() => {
    if (tab !== "files" || !canRead) {
      return;
    }

    let active = true;

    void computerRpc("computer.files", { path })
      .then((next) => {
        if (active) {
          setFiles(next);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      active = false;
    };
  }, [tab, path, canRead]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (reason) {
      if (owned.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (owned.current) {
        setBusy(false);
      }
    }
  };

  const control = (input: ComputerRpc["computer.control"]["input"]) =>
    run(() => computerRpc("computer.control", input));

  const changing = busy || status?.status === "starting";

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-border-default bg-background"
      aria-label="Shared Computer"
    >
      <header className="flex min-h-[44px] items-center gap-2 border-b border-border-default px-4">
        <Monitor size={16} aria-hidden="true" />
        <h2 className="m-0 grow text-sm font-semibold">Shared Computer</h2>
        {status && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-surface-hover px-2.5 py-1 text-xs"
            role="status"
            aria-label={`Computer: ${labels[status.status]}`}
          >
            <span
              className={`size-1.5 rounded-full ${ready ? "bg-green-500" : "bg-current"}`}
              aria-hidden="true"
            />
            {labels[status.status]}
          </span>
        )}
        <Button size="icon" variant="ghost" onClick={hide} aria-label="Close Computer">
          <X size={16} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <p className="m-0 text-xs leading-relaxed text-ink-muted">
          Vibers can use the same files when you enable Computer in a chat. Browser sessions are
          shared across this workspace.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {ready || (status?.status === "error" && status.has_data && status.docker?.ready) ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={changing}
                onClick={() => void control({ action: "stop" })}
              >
                Stop
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={changing}
                onClick={() => void control({ action: "restart" })}
              >
                Restart
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={changing || !status?.docker?.ready}
              onClick={() => void control({ action: "start" })}
            >
              Start
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={changing || !status?.has_data || !status.docker?.ready}
            onClick={() => setReset(true)}
          >
            Reset
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={changing}
            onClick={refresh}
            aria-label="Check prerequisites"
          >
            <RotateCw size={14} />
          </Button>
        </div>

        {(!ready || error) && (
          <div className="grid gap-2 rounded-xl border border-border-default px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span>Linux / WSL helper</span>
              {supported ? (
                <Check size={14} aria-label="Ready" />
              ) : (
                <Button size="sm" variant="secondary" onClick={settings}>
                  Execution settings
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>Docker Engine</span>
              {status?.docker?.ready ? (
                <Check size={14} aria-label="Ready" />
              ) : (
                <CircleAlert size={14} aria-label="Check the Docker connection" />
              )}
            </div>
            {(error || status?.error) && (
              <p className="m-0 break-words text-accent-amber" role="alert">
                {error || status?.error}
              </p>
            )}
            {status?.status === "starting" && (
              <p className="m-0 text-ink-muted">
                Preparing Linux and Chromium. First start may take a few minutes.
              </p>
            )}
          </div>
        )}

        <div
          className="inline-flex self-start gap-1 rounded-lg bg-surface-hover p-1"
          role="group"
          aria-label="Computer views"
        >
          {tabs.map(({ id, label, Icon }) => (
            <Button
              key={id}
              size="sm"
              variant={tab === id ? "secondary" : "ghost"}
              aria-pressed={tab === id}
              onClick={() => {
                setError("");
                setTab(id);
              }}
            >
              <Icon size={14} />
              {label}
            </Button>
          ))}
        </div>

        {tab === "desktop" &&
          (ready ? (
            <ComputerDesktop />
          ) : (
            <div className="grid aspect-[25/16] place-content-center justify-items-center gap-2 rounded-xl border border-border-default bg-surface-hover text-ink-muted">
              <Monitor size={24} /> Start the computer to open its desktop.
            </div>
          ))}
        {tab === "terminal" &&
          (ready ? (
            <>
              <div>
                {shell ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await computerRpc("computer.terminal.close", { terminal_id: shell });
                        setShell((current) => (current === shell ? undefined : current));
                      })
                    }
                  >
                    Close shell
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        setShell((await computerRpc("computer.terminal.open", {})).id),
                      )
                    }
                  >
                    Open shell
                  </Button>
                )}
              </div>
              {shell && <ComputerTerminal report={setError} />}
            </>
          ) : (
            <p className="m-0 text-sm text-ink-muted">Start the computer to open a shell.</p>
          ))}
        {tab === "files" &&
          (canRead ? (
            <>
              <div className="flex items-center gap-2 text-xs">
                {path && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
                  >
                    Up
                  </Button>
                )}
                <code className="break-all">/{path}</code>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Refresh files"
                  onClick={() =>
                    void run(async () => setFiles(await computerRpc("computer.files", { path })))
                  }
                >
                  <RotateCw size={14} />
                </Button>
              </div>
              {files?.path === path &&
                (files.text !== null ? (
                  <pre className="m-0 whitespace-pre-wrap break-words rounded-xl border border-border-default p-3 text-xs">
                    {files.text}
                  </pre>
                ) : files.entries.length ? (
                  <div className="flex flex-col items-stretch gap-0.5">
                    {files.entries.map((entry) => (
                      <Button
                        key={entry.name}
                        className="justify-start"
                        variant="ghost"
                        onClick={() => {
                          setError("");
                          setPath([path, entry.name].filter(Boolean).join("/"));
                        }}
                      >
                        {entry.directory && <Folder size={14} />}
                        <span className="truncate">{entry.name}</span>
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="m-0 text-sm text-ink-muted">No shared files yet.</p>
                ))}
            </>
          ) : (
            <p className="m-0 text-sm text-ink-muted">
              Start the computer to create its shared files folder.
            </p>
          ))}
      </div>

      {reset && (
        <WorkspaceOverlay
          label="Reset Shared Computer"
          onClose={() => setReset(false)}
          className="max-w-[460px] p-6"
        >
          <h2>Reset Shared Computer?</h2>
          <p>
            This permanently clears shared files, the Linux home, and Chromium sessions. Viber chats
            and their own workspaces are preserved.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReset(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setReset(false);
                setFiles(undefined);
                setPath("");
                void control({ action: "reset", confirmed: true });
              }}
            >
              Reset computer
            </Button>
          </div>
        </WorkspaceOverlay>
      )}
    </aside>
  );
};
