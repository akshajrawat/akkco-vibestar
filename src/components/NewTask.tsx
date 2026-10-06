import { useState } from "react";
import { X, GitBranch } from "lucide-react";
import { rpc, errorMessage } from "../lib/api";
import type { Repository, Task } from "../lib/types";
import { Button } from "./ui/button";
interface Preview {
  issue: { owner: string; repo: string; number: number };
  repository: Repository | null;
  branch_name: string;
}
export const NewTask = ({
  close,
  created,
}: {
  close: () => void;
  created: (id: string) => void;
}) => {
  const [url, setUrl] = useState("");
  const [scope, setScope] = useState("");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (!preview)
        setPreview(
          await rpc<Preview>("task.preview", {
            issue_url: url,
            claimed_scope: scope,
          }),
        );
      else {
        const t = await rpc<Task>("task.create", {
          issue_url: url,
          claimed_scope: scope,
          notes,
        });
        created(t.id);
        close();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
      >
        <div className="modal-heading">
          <h2 id="new-task-title">New contribution task</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={close}
          >
            <X size={17} />
          </Button>
        </div>
        <p className="subtle">
          One claimed scope. One isolated worktree. Three independent agent
          runs.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            GitHub issue URL
            <input
              autoFocus
              required
              type="url"
              value={url}
              placeholder="https://github.com/oppia/oppia/issues/26831"
              onChange={(e) => {
                setUrl(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label>
            Claimed scope
            <input
              required
              value={scope}
              placeholder="check-improvements-tab.spec.ts"
              onChange={(e) => {
                setScope(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <label>
            Notes
            <textarea
              rows={3}
              value={notes}
              placeholder="Only migrate this spec. Other checklist items belong to other tasks."
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          {preview && (
            <div className="preview">
              <strong>
                {preview.issue.owner}/{preview.issue.repo} · #
                {preview.issue.number}
              </strong>
              <div>
                Scope <code>{scope}</code>
              </div>
              <div>
                Base{" "}
                <code>
                  upstream/{preview.repository?.base_branch || "not configured"}
                </code>
              </div>
              <div>
                <GitBranch size={13} />
                <code>{preview.branch_name}</code>
              </div>
              {!preview.repository && (
                <div className="warning-box">
                  Register this repository on the Repositories page before
                  creating the task.
                </div>
              )}
            </div>
          )}
          {error && <div className="error-box">{error}</div>}
          <div className="modal-actions">
            <Button type="button" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="default"
              disabled={busy || (!!preview && !preview.repository)}
              type="submit"
            >
              {busy ? "Preparing…" : preview ? "Create & Run" : "Preview task"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
};
