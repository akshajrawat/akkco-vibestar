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
  kind: "repository" | "session";
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
        title={kind !== "repository" ? "Open Viber workspace" : "Open source checkout"}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const result = await rpc<NonNullable<typeof selection>>("editors.list");
            if (kind !== "repository" && result.editors.some((e) => e.id === "code")) {
              await open("code");
            } else if (result.default && result.editors.some((e) => e.id === result.default)) {
              await open(result.default);
            } else {
              setSelection(result);
            }
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
          aria-label="Choose Viber editor"
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
        <div
          className="modal-backdrop fixed inset-[var(--titlebar-height)_0_0] flex items-center justify-center z-[50]"
          onClick={() => setSelection(undefined)}
        >
          <section
            className="modal border border-border-strong p-6 max-w-[94vw] max-h-[90%] overflow-auto [box-shadow:0_12px_45px_var(--overlay)] animate-[surface-enter_var(--motion-enter)_ease-out] compact-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Open in Editor"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{kind === "repository" ? "Open source checkout" : "Open Viber worktree"}</h2>
            <code className="block mb-3 wrap-anywhere">{path}</code>
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
              <p
                className="error-box px-3 py-2 mx-0 my-2 text-[12px] whitespace-pre-wrap wrap-anywhere"
                role="alert"
              >
                {error}
              </p>
            )}

            <div className="actions flex gap-1.5">
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
