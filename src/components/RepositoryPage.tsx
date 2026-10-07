import { useState } from "react";
import {
  Search,
  RefreshCw,
  FolderOpen,
  Trash2,
  GitFork,
  Lock,
} from "lucide-react";
import type { Snapshot } from "../lib/types";
import { Button } from "./ui/button";
import { rpc, errorMessage } from "../lib/api";
export const RepositoryPage = ({
  snapshot,
  refresh,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
}) => {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("Owned");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [upstream, setUpstream] = useState("");
  const [origin, setOrigin] = useState("");
  const [base, setBase] = useState("main");
  const github = snapshot.github;
  const action = async (method: string, params: unknown, key: string) => {
    setBusy(key);
    setError("");
    try {
      await rpc(method, params);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const rows = (github?.repositories || [])
    .filter((r) =>
      `${r.full_name} ${r.description || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .filter((r) =>
      group === "Recent"
        ? snapshot.repositories.some(
            (local) => `${local.owner}/${local.name}` === r.full_name,
          )
        : group === "Owned"
          ? r.owner.login === github?.status?.username && !r.fork
          : group === "Forks"
            ? r.fork
            : group === "Organizations"
              ? r.owner.type === "Organization"
              : true,
    );
  return (
    <div className="page repository-library">
      <div className="page-title">
        <h1>Repositories</h1>
        <Button
          disabled={!!busy}
          onClick={() => void action("github.sync", {}, "sync")}
        >
          <RefreshCw size={13} />
          {busy === "sync" ? "Syncing…" : "Sync GitHub"}
        </Button>
      </div>
      <div className="library-search">
        <Search size={14} />
        <input
          aria-label="Search repositories"
          placeholder="Search repositories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="library-tabs">
        {["Recent", "Owned", "Forks", "Organizations", "All"].map((g) => (
          <button
            className={g === group ? "selected" : ""}
            key={g}
            onClick={() => setGroup(g)}
          >
            {g}
          </button>
        ))}
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {!github?.status?.connected && (
        <p className="empty-row">
          Connect GitHub in Providers to browse your repositories.
        </p>
      )}
      <div className="repo-catalog">
        {rows.map((r) => {
          const local = snapshot.repositories.find(
            (l) =>
              `${l.owner}/${l.name}` === r.full_name ||
              l.origin_url?.replace(/\.git$/, "") ===
                `https://github.com/${r.full_name}`,
          );
          return (
            <div className="repo-catalog-row" key={r.id}>
              <div>
                <strong>{r.name}</strong>
                <span>{r.full_name}</span>
                <small>
                  {r.default_branch} ·{" "}
                  {r.private ? (
                    <>
                      <Lock size={10} /> private
                    </>
                  ) : (
                    "public"
                  )}{" "}
                  ·{" "}
                  {r.fork ? (
                    <>
                      <GitFork size={10} /> fork
                    </>
                  ) : (
                    "original"
                  )}
                </small>
              </div>
              <div className="spacer" />
              {local ? <span className="success">Managed locally</span> : null}
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  void action(
                    "github.use",
                    { repository: r.full_name },
                    String(r.id),
                  )
                }
              >
                {busy === String(r.id) ? "Preparing clone…" : "Use locally"}
              </Button>
            </div>
          );
        })}
      </div>
      {github?.status?.connected && !rows.length && (
        <p className="empty-row">
          {github.last_sync
            ? "No repositories in this view."
            : "Fetching your repository catalog…"}
        </p>
      )}
      {!!snapshot.repositories.length && (
        <section className="managed-repos">
          <h2>Managed local clones</h2>
          {snapshot.repositories.map((r) => (
            <details key={r.id} className="managed-repo">
              <summary>
                <FolderOpen size={13} />
                {r.owner}/{r.name}
                <code>upstream/{r.base_branch}</code>
              </summary>
              <p className="mono">{r.path}</p>
              <p className="subtle">
                {r.upstream_url}
                {r.origin_url ? ` · origin ${r.origin_url}` : ""}
              </p>
              <div className="actions">
                <Button
                  size="sm"
                  onClick={() =>
                    void action("repository.fetch", { id: r.id }, r.id)
                  }
                  disabled={!!busy}
                >
                  Fetch upstream
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    void action(
                      "open.directory",
                      { id: r.id, kind: "repository" },
                      r.id,
                    )
                  }
                >
                  Open directory
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${r.owner}/${r.name} and all its tasks and worktrees?`,
                      )
                    )
                      void action(
                        "repository.remove",
                        { id: r.id, confirmed: true },
                        r.id,
                      );
                  }}
                >
                  <Trash2 size={12} />
                  Remove
                </Button>
              </div>
            </details>
          ))}
        </section>
      )}
      <details className="advanced-repository">
        <summary>Advanced · add by Git URL</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(
              "repository.add",
              {
                upstream_url: upstream,
                origin_url: origin || null,
                base_branch: base,
              },
              "manual",
            );
          }}
        >
          <label>
            Upstream URL
            <input
              required
              value={upstream}
              onChange={(e) => setUpstream(e.target.value)}
            />
          </label>
          <label>
            Fork / origin URL
            <input value={origin} onChange={(e) => setOrigin(e.target.value)} />
          </label>
          <label>
            Base branch
            <input
              required
              value={base}
              onChange={(e) => setBase(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={!!busy}>
            Prepare managed clone
          </Button>
        </form>
      </details>
    </div>
  );
};
