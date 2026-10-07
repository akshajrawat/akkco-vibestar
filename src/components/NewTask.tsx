import { useState, useEffect } from "react";
import { X, ArrowUpRight } from "lucide-react";
import { rpc, errorMessage } from "../lib/api";
import type { Repository, Task, Settings, Snapshot } from "../lib/types";
import { parseIssue, repositoryMatchesIssue } from "../../backend/domain";
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
  repository: Repository;
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
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [root, setRoot] = useState("");
  const [manualSelection, setManualSelection] = useState(false);
  const [matched, setMatched] = useState(false);
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc<Snapshot>("snapshot")
      .then((s) => {
        setSettings(s.settings);
        const active = s.repositories.filter((r) => r.connected !== false);
        setRepositories(active);
        setRepositoryId(active[0]?.id || "");
        setRoot(s.root);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const selected = repositories.find((r) => r.id === repositoryId);
  let reference: ReturnType<typeof parseIssue> | undefined;
  try {
    reference = parseIssue(url);
  } catch {
    /* The URL field may still be incomplete. */
  }
  const mismatch =
    !!reference && !!selected && !repositoryMatchesIssue(selected, reference);
  const matching = reference
    ? repositories.filter((r) => repositoryMatchesIssue(r, reference!))
    : [];
  useEffect(() => {
    if (manualSelection) return;
    let issue: ReturnType<typeof parseIssue>;
    try {
      issue = parseIssue(url);
    } catch {
      setMatched(false);
      return;
    }
    const matches = repositories.filter((r) =>
      repositoryMatchesIssue(r, issue),
    );
    if (matches.length === 1) {
      setRepositoryId(matches[0].id);
      setMatched(true);
    } else setMatched(false);
  }, [url, repositories, manualSelection]);
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError("");
    setResolving(false);
    if (!selected || mismatch) return;
    if (
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+\/?$/.test(
        url.trim(),
      )
    )
      return;
    setResolving(true);
    const timer = setTimeout(
      () =>
        void rpc<Preview>("task.preview", {
          repository_id: repositoryId,
          issue_url: url.trim(),
        })
          .then((p) => {
            if (alive) {
              setPreview(p);
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
  }, [url, repositoryId, mismatch, selected]);
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
            if (
              !preview ||
              !selected ||
              mismatch ||
              preview.repository.id !== selected.id
            )
              return;
            setBusy(true);
            setError("");
            try {
              const task = await rpc<Task>("task.create", {
                repository_id: selected.id,
                issue_url: url.trim(),
                scope_mode: mode,
                claimed_scope: mode === "partial" ? scope : "",
                notes,
                settings,
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
            Repository
            <select
              required
              aria-label="Repository"
              value={repositoryId}
              onChange={(e) => {
                setRepositoryId(e.target.value);
                setManualSelection(true);
                setMatched(false);
              }}
            >
              {!repositories.length && (
                <option value="">No active repositories</option>
              )}
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.name} · {r.path}
                </option>
              ))}
            </select>
          </label>
          {!repositories.length && (
            <p className="empty-row">
              Connect a local repository on the Repositories page before
              starting a task.
            </p>
          )}
          {selected && (
            <p className="selected-repository-meta">
              <code>{selected.path}</code>
              <small>
                {selected.environment === "windows" ||
                selected.path.startsWith("/mnt/")
                  ? "Windows"
                  : "WSL"}{" "}
                · {selected.base_branch}
                {matched ? " · ✓ Matched from issue URL" : ""}
              </small>
            </p>
          )}
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
          {resolving && <p className="subtle">Fetching issue preview…</p>}
          {mismatch && reference && selected && (
            <div role="alert" className="error-box">
              <strong>Repository mismatch</strong>
              <p>
                This issue belongs to: {reference.owner}/{reference.repo}
                <br />
                Selected repository: {selected.owner}/{selected.name}
              </p>
              {matching.length === 1 && (
                <Button
                  onClick={() => {
                    setRepositoryId(matching[0].id);
                    setManualSelection(true);
                    setMatched(false);
                  }}
                >
                  Switch to {matching[0].owner}/{matching[0].name}
                </Button>
              )}
            </div>
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
          {selected && (
            <details className="task-configuration" open>
              <summary>Repository source &amp; task workspace</summary>
              <dl className="repository-facts">
                <dt>Source</dt>
                <dd>
                  <code>{selected.path}</code>
                </dd>
                <dt>Ownership</dt>
                <dd>
                  {selected.source === "imported"
                    ? "User-owned checkout"
                    : "Vibestar-managed clone"}
                </dd>
                <dt>Task workspace</dt>
                <dd>
                  Will be created under:
                  <code>
                    {root}/worktrees/{selected.id}/
                    {reference ? reference.number + "-…" : "…"}
                  </code>
                </dd>
                <dt>Base</dt>
                <dd>
                  {selected.upstream_remote || "upstream"}/
                  {selected.base_branch}
                </dd>
              </dl>
              <p className="subtle">
                All agent changes remain in the task worktree.
              </p>
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
                !selected ||
                mismatch ||
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
