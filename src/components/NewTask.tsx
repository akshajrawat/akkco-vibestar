import { useState, useEffect } from "react";
import { X, ArrowUpRight } from "lucide-react";
import { rpc, errorMessage } from "../lib/api";
import type { Repository, Task, Settings, Snapshot } from "../lib/types";
import type { GitHubRepository } from "../../backend/github/contracts";
import { StageSettings } from "./StageSettings";
import { Button } from "./ui/button";
interface Preview {
  reference: { owner: string; repo: string; number: number };
  issue: {
    title: string;
    body: string;
    labels?: { name: string }[];
    comments?: unknown[];
  };
  repository: Repository | null;
  resolved: {
    repository: GitHubRepository;
    upstream_url: string;
    origin_url: string | null;
    base_branch: string;
  };
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
  const [mode, setMode] = useState<"whole_issue" | "partial">("whole_issue");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [settings, setSettings] = useState<Settings>();
  const [advanced, setAdvanced] = useState<Preview["resolved"]>();
  const [override, setOverride] = useState(false);
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc<Snapshot>("snapshot")
      .then((s) => setSettings(s.settings))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError("");
    setOverride(false);
    setResolving(false);
    if (
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+\/?$/.test(
        url.trim(),
      )
    )
      return;
    setResolving(true);
    const timer = setTimeout(
      () =>
        void rpc<Preview>("task.preview", { issue_url: url.trim() })
          .then((p) => {
            if (alive) {
              setPreview(p);
              setAdvanced(p.resolved);
            }
          })
          .catch((e) => {
            if (alive) setError(errorMessage(e));
          })
          .finally(() => {
            if (alive) setResolving(false);
          }),
      350,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section
        className="modal task-composer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) close();
        }}
      >
        <div className="modal-heading">
          <h2 id="new-task-title">New task</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={close}
          >
            <X size={16} />
          </Button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!preview) return;
            setBusy(true);
            setError("");
            try {
              const task = await rpc<Task>("task.create", {
                issue_url: url.trim(),
                scope_mode: mode,
                claimed_scope: mode === "partial" ? scope : "",
                notes,
                settings,
                ...(override && advanced
                  ? {
                      advanced: {
                        upstream_url: advanced.upstream_url,
                        origin_url: advanced.origin_url,
                        base_branch: advanced.base_branch,
                      },
                    }
                  : {}),
              });
              created(task.id);
              close();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Issue URL
            <input
              autoFocus
              required
              type="url"
              value={url}
              placeholder="https://github.com/oppia/oppia/issues/26831"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          {resolving && (
            <p className="subtle">Fetching issue and repository…</p>
          )}
          {preview && (
            <>
              <div className="resolved-issue">
                <small>
                  {preview.reference.owner}/{preview.reference.repo} #
                  {preview.reference.number}
                </small>
                <strong>{preview.issue.title}</strong>
                <details>
                  <summary>
                    Issue requirements · {preview.issue.comments?.length || 0}{" "}
                    comments
                  </summary>
                  <div className="issue-body">{preview.issue.body}</div>
                </details>
              </div>
              <fieldset className="scope-options">
                <legend>Scope</legend>
                <label>
                  <input
                    type="radio"
                    name="scope"
                    checked={mode === "whole_issue"}
                    onChange={() => setMode("whole_issue")}
                  />
                  Entire issue
                </label>
                <label>
                  <input
                    type="radio"
                    name="scope"
                    checked={mode === "partial"}
                    onChange={() => setMode("partial")}
                  />
                  Specific part / claimed subtask
                </label>
              </fieldset>
              {mode === "partial" && (
                <label>
                  Claimed scope
                  <input
                    required
                    maxLength={1000}
                    value={scope}
                    placeholder="check-improvements-tab.spec.ts"
                    onChange={(e) => setScope(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          <label>
            Optional instructions
            <textarea
              rows={2}
              maxLength={32000}
              value={notes}
              placeholder="Additional context or exclusions…"
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <details className="task-configuration">
            <summary>Agent configuration</summary>
            {settings && (
              <StageSettings settings={settings} onChange={setSettings} />
            )}
          </details>
          {preview && (
            <details className="task-configuration">
              <summary>Advanced · repository</summary>
              <p className="subtle">
                {preview.repository
                  ? "Uses your managed clone"
                  : "Managed clone will be prepared when the task starts"}{" "}
                · base {preview.resolved.base_branch}
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(e) => setOverride(e.target.checked)}
                />
                Override inferred remotes
              </label>
              {override && preview.repository && (
                <small>
                  Updates this managed repository for future tasks. Existing
                  worktrees stay pinned.
                </small>
              )}
              {override && advanced && (
                <>
                  <label>
                    Upstream URL
                    <input
                      value={advanced.upstream_url}
                      onChange={(e) =>
                        setAdvanced({
                          ...advanced,
                          upstream_url: e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Fork / origin URL
                    <input
                      value={advanced.origin_url || ""}
                      onChange={(e) =>
                        setAdvanced({
                          ...advanced,
                          origin_url: e.target.value || null,
                        })
                      }
                    />
                  </label>
                  <label>
                    Base branch
                    <input
                      value={advanced.base_branch}
                      onChange={(e) =>
                        setAdvanced({
                          ...advanced,
                          base_branch: e.target.value,
                        })
                      }
                    />
                  </label>
                </>
              )}
            </details>
          )}
          {error && (
            <p role="alert" className="error-box">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <small>Antigravity plan → Codex plan → Codex implementation</small>
            <Button
              variant="default"
              type="submit"
              disabled={
                busy ||
                resolving ||
                !preview ||
                (mode === "partial" && !scope.trim())
              }
            >
              {busy ? "Starting…" : "Start task"}
              <ArrowUpRight size={13} />
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
};
