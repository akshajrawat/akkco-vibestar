import { useCallback, useEffect, useState } from "react";
import { Folder, File, Monitor, X } from "lucide-react";

import type { ComputerStatus, ComputerFiles } from "../../../core/computers/contracts";
import { computerRpc, subscribe, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { ComputerTerminal } from "./ComputerTerminal";
import { ComputerBrowser } from "./ComputerBrowser";

type Action = "stop" | "restart" | "reset" | "codex" | "antigravity";

export const ComputerPanel = ({
  profileId,
  sessionId,
  visible,
  hide,
  refreshProviders,
}: {
  profileId: string;
  sessionId?: string;
  visible: boolean;
  hide: () => void;
  refreshProviders: () => Promise<void>;
}) => {
  const [status, setStatus] = useState<ComputerStatus>();

  const [tab, setTab] = useState(() => {
    const saved = localStorage.getItem("vibestar.computerTab");
    if (saved === "files" || saved === "browser") {
      return saved;
    }

    return "terminal";
  });

  const [files, setFiles] = useState<ComputerFiles>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Action>();
  const scope = { profile_id: profileId, ...(sessionId ? { session_id: sessionId } : {}) };

  const refresh = useCallback(async () => {
    setStatus(await computerRpc("computer.status", { profile_id: profileId }));
  }, [profileId]);

  useEffect(() => {
    let alive = true;

    void computerRpc("computer.status", { profile_id: profileId })
      .then((value) => {
        if (alive) {
          setStatus(value);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(errorMessage(err));
        }
      });

    const subscription = subscribe((event) => {
      if (
        event.event === "computer.changed" &&
        (event.data as ComputerStatus).profile_id === profileId
      ) {
        setStatus(event.data as ComputerStatus);
      }
    });

    return () => {
      alive = false;
      void subscription.then((unsubscribe) => unsubscribe());
    };
  }, [profileId]);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const browse = async (path = "") => {
    if (!sessionId) {
      return;
    }

    const next = await computerRpc("computer.files", { ...scope, session_id: sessionId, path });
    setFiles(next);
  };

  useEffect(() => {
    setFiles(undefined);
  }, [sessionId]);

  const selectTab = (value: string) => {
    setTab(value);
    localStorage.setItem("vibestar.computerTab", value);
  };

  const control = (action: "start" | "stop" | "restart" | "reset") =>
    computerRpc("computer.control", {
      ...scope,
      action,
      ...(action === "start" ? {} : { confirmed: true as const }),
    });

  const confirm = async () => {
    const action = confirmation!;
    setConfirmation(undefined);

    await run(() =>
      action === "codex" || action === "antigravity"
        ? computerRpc("computer.terminal.open", { ...scope, login: action, confirmed: true })
        : control(action),
    );

    selectTab("terminal");
  };

  const state = status?.status || "stopped";

  return (
    <aside
      className="flex h-full flex-col border-l border-l-border-subtle bg-surface-panel text-[12px] text-ink-secondary"
      hidden={!visible}
      aria-label="Viber computer"
    >
      <header className="flex gap-2 items-center px-2.5 py-2 border-b border-b-border-subtle">
        <Monitor size={15} />
        <strong>Computer</strong>
        <span
          role="status"
          data-state={state}
          className="ml-auto capitalize text-ink-muted data-[state=ready]:text-accent-green data-[state=running]:text-accent-green data-[state=starting]:text-accent-amber data-[state=error]:text-accent-red"
        >
          {state}
        </span>
        <Button size="icon" variant="ghost" aria-label="Hide computer panel" onClick={hide}>
          <X size={14} />
        </Button>
      </header>
      <div className="flex flex-wrap gap-[3px] p-[5px]">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || status?.status === "starting" || status?.status === "running"}
          onClick={() => void run(() => control("start"))}
        >
          Start
        </Button>
        {(["stop", "restart", "reset"] as const).map((action) => (
          <Button
            key={action}
            size="sm"
            variant="ghost"
            disabled={busy || (action === "stop" && status?.status === "stopped")}
            onClick={() => {
              if (action === "stop") {
                void run(() => control("stop"));
              } else {
                setConfirmation(action);
              }
            }}
          >
            {action[0].toUpperCase() + action.slice(1)}
          </Button>
        ))}
      </div>
      {(error || status?.error) && (
        <p role="alert" className="px-2.5 py-1 text-accent-red m-0 text-[11px] leading-tight">
          {error || status?.error}
        </p>
      )}
      <div className="flex border-b border-b-border-subtle p-1 gap-1" role="tablist">
        <Button
          size="sm"
          variant={tab === "terminal" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={tab === "terminal"}
          className={`flex-1 ${tab === "terminal" ? "text-ink font-semibold" : "text-ink-muted"}`}
          onClick={() => selectTab("terminal")}
        >
          Terminal
        </Button>
        <Button
          size="sm"
          variant={tab === "browser" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={tab === "browser"}
          className={`flex-1 ${tab === "browser" ? "text-ink font-semibold" : "text-ink-muted"}`}
          onClick={() => selectTab("browser")}
        >
          Browser
        </Button>
        <Button
          size="sm"
          variant={tab === "files" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={tab === "files"}
          className={`flex-1 ${tab === "files" ? "text-ink font-semibold" : "text-ink-muted"}`}
          onClick={() => selectTab("files")}
        >
          Files
        </Button>
      </div>
      <div
        className="flex-1 flex flex-col min-h-0"
        role="tabpanel"
        aria-label="Terminal"
        hidden={tab !== "terminal"}
      >
        <div className="flex flex-wrap gap-[3px] p-[5px]">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => computerRpc("computer.terminal.open", scope))}
          >
            Open shell
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(() => computerRpc("computer.terminal.close", { profile_id: profileId }))
            }
          >
            Close shell
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(refreshProviders)}
          >
            Refresh models
          </Button>
        </div>
        <ComputerTerminal
          profileId={profileId}
          sessionId={sessionId}
          active={visible && tab === "terminal"}
          report={setError}
        />
        <details className="border-t border-t-border-subtle p-2.5 [&>p]:my-2 [&>p]:leading-[1.6]">
          <summary>Provider setup</summary>
          <p>
            Sign into each Viber separately using your subscription. Codex is installed. Install the
            official Linux Antigravity CLI in ~/.local/bin using the shell. User tools, Python
            environments and npm installs in your home persist.
          </p>
          <div className="flex flex-wrap gap-[3px] p-[5px]">
            <Button size="sm" disabled={busy} onClick={() => setConfirmation("codex")}>
              Sign in to Codex
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirmation("antigravity")}>
              Sign in to Antigravity
            </Button>
          </div>
          <p>
            Close the login terminal, start the computer, then refresh models. Close any shell
            before sending a chat message.
          </p>
        </details>
      </div>
      <div
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
        role="tabpanel"
        aria-label="Browser"
        hidden={tab !== "browser"}
      >
        <ComputerBrowser profileId={profileId} active={visible && tab === "browser"} />
      </div>
      <div
        className="flex-1 flex flex-col min-h-0 overflow-auto computer-files"
        role="tabpanel"
        aria-label="Files"
        hidden={tab !== "files"}
      >
        <div className="flex flex-wrap gap-[3px] p-[5px]">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !sessionId}
            onClick={() => void run(() => browse())}
          >
            Workspace
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !files?.path}
            onClick={() => void run(() => browse(files?.path.split("/").slice(0, -1).join("/")))}
          >
            Up
          </Button>
        </div>
        {!sessionId && (
          <p className="px-3 py-2 wrap-anywhere">Start a chat to browse its workspace.</p>
        )}
        {sessionId && !files && (
          <p className="px-3 py-2 wrap-anywhere">Select Workspace to browse accessible files.</p>
        )}
        <code className="px-3 py-1.5 text-ink-muted wrap-anywhere">{files?.path || "/"}</code>
        {files?.entries.map((entry) => (
          <button
            className="flex items-center gap-[7px] px-3 py-1.5 text-left wrap-anywhere [&:hover]:bg-surface-hover"
            key={entry.name}
            onClick={() =>
              void run(() => browse([files.path, entry.name].filter(Boolean).join("/")))
            }
          >
            {entry.directory ? <Folder size={14} /> : <File size={14} />}
            {entry.name}
          </button>
        ))}
        {files?.text !== null && files?.text !== undefined && (
          <pre className="p-3 overflow-auto text-[12px] whitespace-pre">{files.text}</pre>
        )}
      </div>
      {confirmation && (
        <WorkspaceOverlay
          label="Confirm computer action"
          onClose={() => setConfirmation(undefined)}
          className="computer-confirmation max-w-[480px] p-6"
        >
          <h2>
            {confirmation === "codex" || confirmation === "antigravity"
              ? "Connect this Viber's account?"
              : `${confirmation[0].toUpperCase() + confirmation.slice(1)} computer?`}
          </h2>
          <p className="my-4 leading-[1.6]">
            {confirmation === "reset"
              ? "This permanently deletes this computer's home, account sessions, user data and installed dependencies. Chat workspace files are preserved. Native AI context will be cleared."
              : confirmation === "codex" || confirmation === "antigravity"
                ? "The official CLI will authenticate inside this Viber's private computer. Host credentials are never copied. Credentials saved here belong to this Viber until reset or deletion."
                : "This closes the computer's shell and stops its processes. Saved home and workspace files remain."}
          </p>
          <footer className="flex justify-end gap-2">
            <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
            <Button onClick={() => void confirm()}>Confirm</Button>
          </footer>
        </WorkspaceOverlay>
      )}
    </aside>
  );
};
