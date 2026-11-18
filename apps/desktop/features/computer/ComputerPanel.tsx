import { useCallback, useEffect, useState } from "react";
import { Folder, File, Monitor, X } from "lucide-react";

import type { ComputerStatus, ComputerFiles } from "../../../core/computers/contracts";
import { computerRpc, subscribe, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { ComputerTerminal } from "./ComputerTerminal";

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

  const [tab, setTab] = useState(() =>
    localStorage.getItem("vibestar.computerTab") === "files" ? "files" : "terminal",
  );

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
      .catch((error) => {
        if (alive) {
          setError(errorMessage(error));
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
    } catch (error) {
      setError(errorMessage(error));
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

  return (
    <aside className="computer-panel" hidden={!visible} aria-label="Viber computer">
      <header className="computer-panel-header">
        <Monitor size={15} />
        <strong>Computer</strong>
        <span role="status" className={`computer-status ${status?.status || "stopped"}`}>
          {status?.status || "stopped"}
        </span>
        <Button size="icon" variant="ghost" aria-label="Hide computer panel" onClick={hide}>
          <X size={14} />
        </Button>
      </header>
      <div className="computer-controls">
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
            disabled={busy || status?.status === "starting"}
            onClick={() => setConfirmation(action)}
          >
            {action[0].toUpperCase() + action.slice(1)}
          </Button>
        ))}
      </div>
      {status?.session_id && sessionId && status.session_id !== sessionId && (
        <p className="computer-notice">
          The computer is attached to another chat. Close its terminal before switching workspaces.
        </p>
      )}
      {(error || status?.error) && (
        <p role="alert" className="computer-error">
          {error || status?.error}
        </p>
      )}
      <div role="tablist" aria-label="Computer views" className="computer-tabs">
        <button role="tab" aria-selected={tab === "terminal"} onClick={() => selectTab("terminal")}>
          Terminal
        </button>
        <button role="tab" aria-selected={tab === "files"} onClick={() => selectTab("files")}>
          Files
        </button>
      </div>
      <div
        className="computer-tab"
        role="tabpanel"
        aria-label="Terminal"
        hidden={tab !== "terminal"}
      >
        <div className="computer-controls">
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
        <details className="computer-setup">
          <summary>Provider setup</summary>
          <p>
            Sign into each Viber separately using your subscription. Codex is installed. Install the
            official Linux Antigravity CLI in ~/.local/bin using the shell. User tools, Python
            environments and npm installs in your home persist.
          </p>
          <div className="computer-controls">
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
        className="computer-tab computer-files"
        role="tabpanel"
        aria-label="Files"
        hidden={tab !== "files"}
      >
        <div className="computer-controls">
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
        {!sessionId && <p className="computer-notice">Start a chat to browse its workspace.</p>}
        {sessionId && !files && (
          <p className="computer-notice">Select Workspace to browse accessible files.</p>
        )}
        <code className="computer-file-path">{files?.path || "/"}</code>
        {files?.entries.map((entry) => (
          <button
            className="computer-file"
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
          <pre className="computer-file-preview">{files.text}</pre>
        )}
      </div>
      {confirmation && (
        <WorkspaceOverlay
          label="Confirm computer action"
          onClose={() => setConfirmation(undefined)}
          className="computer-confirmation"
        >
          <h2>
            {confirmation === "codex" || confirmation === "antigravity"
              ? "Connect this Viber's account?"
              : `${confirmation[0].toUpperCase() + confirmation.slice(1)} computer?`}
          </h2>
          <p>
            {confirmation === "reset"
              ? "This permanently deletes this computer's home, account sessions, user data and installed dependencies. Chat workspace files are preserved. Native AI context will be cleared."
              : confirmation === "codex" || confirmation === "antigravity"
                ? "The official CLI will authenticate inside this Viber's private computer. Host credentials are never copied. Credentials saved here belong to this Viber until reset or deletion."
                : "This closes the computer's shell and stops its processes. Saved home and workspace files remain."}
          </p>
          <footer>
            <Button onClick={() => setConfirmation(undefined)}>Cancel</Button>
            <Button onClick={() => void confirm()}>Confirm</Button>
          </footer>
        </WorkspaceOverlay>
      )}
    </aside>
  );
};
