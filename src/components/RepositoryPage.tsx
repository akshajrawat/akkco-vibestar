import { useState } from "react";
import { FolderOpen, RefreshCw, Plus, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import type { Repository } from "../lib/types";
import { rpc, errorMessage } from "../lib/api";
export const RepositoryForm = ({ done }: { done: () => void }) => {
  const [upstream, setUpstream] = useState("");
  const [origin, setOrigin] = useState("");
  const [base, setBase] = useState("main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="form-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await rpc("repository.add", {
            upstream_url: upstream,
            origin_url: origin || null,
            base_branch: base,
          });
          done();
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Add managed repository</h2>
      <p className="subtle">
        One Linux clone per upstream. Task worktrees share its Git objects.
      </p>
      <label>
        Upstream URL
        <input
          required
          placeholder="https://github.com/oppia/oppia.git"
          value={upstream}
          onChange={(e) => setUpstream(e.target.value)}
        />
      </label>
      <label>
        Fork / origin URL <span className="subtle">optional</span>
        <input
          placeholder="git@github.com:your-name/oppia.git"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
        />
      </label>
      <label>
        Base branch
        <input
          required
          value={base}
          onChange={(e) => setBase(e.target.value)}
        />
      </label>
      {error && <div className="error-box">{error}</div>}
      <Button type="submit" variant="default" disabled={busy}>
        {busy ? "Cloning and fetching…" : "Register repository"}
      </Button>
    </form>
  );
};
export const RepositoryPage = ({
  repositories,
  refresh,
}: {
  repositories: Repository[];
  refresh: () => Promise<void>;
}) => {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState<
    Record<string, { disk_usage: string; active_worktrees: number }>
  >({});
  const action = async (method: string, r: Repository) => {
    setBusy(r.id);
    try {
      if (
        method === "repository.remove" &&
        !window.confirm(
          `Permanently remove the managed clone ${r.owner}/${r.name}? This removes all its task worktrees, changes, logs in the database, and task history.`,
        )
      )
        return;
      await rpc(method, { id: r.id, kind: "repository", confirmed: true });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">HARNESS-MANAGED CLONES</span>
          <h1>Repositories</h1>
        </div>
        <Button onClick={() => setAdding(!adding)}>
          <Plus size={14} />
          Add repository
        </Button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {adding && (
        <RepositoryForm
          done={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
      {repositories.map((r) => (
        <section className="repository-row" key={r.id}>
          <div className="repo-heading">
            <h2>
              {r.owner}/{r.name}
            </h2>
            <code>upstream/{r.base_branch}</code>
          </div>
          <dl>
            <dt>Upstream</dt>
            <dd>{r.upstream_url}</dd>
            <dt>Origin</dt>
            <dd>{r.origin_url || "No fork configured"}</dd>
            <dt>Managed path</dt>
            <dd className="mono">{r.path}</dd>
            <dt>Last fetched</dt>
            <dd>
              {r.last_fetched
                ? new Date(r.last_fetched).toLocaleString()
                : "Never"}
            </dd>
            {info[r.id] && (
              <>
                <dt>Storage / worktrees</dt>
                <dd>
                  {info[r.id].disk_usage} · {info[r.id].active_worktrees}{" "}
                  worktrees
                </dd>
              </>
            )}
          </dl>
          <div className="actions">
            <Button
              disabled={busy === r.id}
              onClick={() => void action("repository.fetch", r)}
            >
              <RefreshCw size={13} />
              Fetch upstream
            </Button>
            <Button onClick={() => void action("open.directory", r)}>
              <FolderOpen size={13} />
              Open directory
            </Button>
            <Button
              onClick={() =>
                void rpc<{ disk_usage: string; active_worktrees: number }>(
                  "repository.info",
                  { id: r.id },
                )
                  .then((v) => setInfo({ ...info, [r.id]: v }))
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              Disk usage
            </Button>
            <Button
              variant="ghost"
              onClick={() => void action("repository.remove", r)}
            >
              <Trash2 size={13} />
              Remove
            </Button>
          </div>
        </section>
      ))}
      {repositories.length === 0 && !adding && (
        <p className="empty-row">
          No registered repositories. Add your upstream and optional fork to
          begin.
        </p>
      )}
    </div>
  );
};
