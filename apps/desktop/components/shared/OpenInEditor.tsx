import { useState } from "react";
import { Code2 } from "lucide-react";

import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../ui/button";

export const OpenInEditor = ({
  id,
  kind,
  path,
  disabled = false,
}: {
  id: string;
  kind: "task" | "repository" | "repair";
  path: string;
  disabled?: boolean;
}) => {
  const [selection, setSelection] = useState<{
    editors: { id: string; label: string }[];
    default: string;
  }>();

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const open = async (editor: string) => {
    setBusy(true);
    setError("");
    try {
      await rpc("editors.open", { id, kind, editor });
      setSelection(undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor-launcher">
      <Button
        size="sm"
        variant={kind !== "repository" ? "default" : "secondary"}
        disabled={disabled || busy}
        title={kind !== "repository" ? "Open task workspace" : "Open source checkout"}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const result = await rpc<NonNullable<typeof selection>>("editors.list");
            if (kind !== "repository" && result.editors.some((e) => e.id === "code"))
              await open("code");
            else if (result.default && result.editors.some((e) => e.id === result.default))
              await open(result.default);
            else setSelection(result);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Code2 size={14} />
        {busy ? "Opening editor…" : kind !== "repository" ? "Open in VS Code" : "Open in Editor ▾"}
      </Button>

      {kind !== "repository" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || busy}
          aria-label={kind === "repair" ? "Choose repair editor" : "Choose task editor"}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setSelection(await rpc<NonNullable<typeof selection>>("editors.list"));
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          ▾
        </Button>
      )}

      {selection && (
        <div className="modal-backdrop" onClick={() => setSelection(undefined)}>
          <section
            className="modal compact-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Open in Editor"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>
              {kind === "repository"
                ? "Open source checkout"
                : kind === "repair"
                  ? "Open PR repair worktree"
                  : "Open task worktree"}
            </h2>
            <code className="repository-path">{path}</code>
            {busy && (
              <p className="subtle" role="status">
                Opening through the editor CLI. On first use, WSL integration may need to download
                and install its editor server.
              </p>
            )}

            {!selection.editors.length && (
              <p>
                No supported editor CLI detected. Install code, cursor, windsurf or codium in your
                execution environment.
              </p>
            )}

            <div className="editor-options">
              {selection.editors.map((editor) => (
                <Button key={editor.id} disabled={busy} onClick={() => void open(editor.id)}>
                  {editor.label}
                  {selection.default === editor.id ? " · Default" : ""}
                </Button>
              ))}
            </div>

            {error && (
              <p className="error-box" role="alert">
                {error}
              </p>
            )}

            <div className="actions">
              <Button
                onClick={() =>
                  void rpc("open.directory", { id, kind }).catch((e) => setError(errorMessage(e)))
                }
              >
                Open folder
              </Button>

              <Button
                onClick={() =>
                  void navigator.clipboard.writeText(path).catch((e) => setError(errorMessage(e)))
                }
              >
                Copy path
              </Button>

              <Button variant="ghost" onClick={() => setSelection(undefined)}>
                Close
              </Button>
            </div>
          </section>
        </div>
      )}

      {error && !selection && (
        <small role="alert" className="failure">
          {error}
        </small>
      )}
    </div>
  );
};
