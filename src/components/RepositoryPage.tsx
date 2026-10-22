import { CloneActivity } from "./CloneActivity";
import { OpenInEditor } from "./OpenInEditor";
import { useState } from "react";
import { Search, RefreshCw, Plus } from "lucide-react";
import type { Snapshot } from "../lib/types";
import type { LocalRepository } from "../../backend/workspace/discovery";
import { Button } from "./ui/button";
import { rpc, errorMessage } from "../lib/api";
import { ConnectLocalRepository } from "./ConnectLocalRepository";
import { remoteIdentity } from "../../backend/domain";

export const RepositoryPage = ({
  snapshot,
  refresh,
  createTask,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
  createTask?: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [verified, setVerified] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState<{ path: string }>();
  const [candidates, setCandidates] = useState<{
    repository: string;
    candidates: LocalRepository[];
  }>();
  const active = snapshot.repositories.filter((r) => r.connected !== false);
  const visible = (text: string) =>
    text.toLowerCase().includes(query.toLowerCase());
  const discovered = (snapshot.repository_index?.repositories || []).filter(
    (r) =>
      !active.some((a) => a.path === r.path) &&
      visible(r.path + " " + r.identities.join(" ")),
  );
  const rows = (snapshot.github?.repositories || []).filter((r) =>
    visible(r.full_name + " " + (r.description || "")),
  );
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
  const find = async (repository: string) => {
    setBusy(repository);
    setError("");
    try {
      const result = await rpc<{ candidates: LocalRepository[] }>(
        "repositories.candidates",
        { repository },
      );
      setCandidates({ repository, candidates: result.candidates });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const verify = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      const result = await rpc<{ branch: string; dirty: boolean }>(
        "repository.verify",
        { id },
      );
      setVerified((previous) => ({
        ...previous,
        [id]: `Verified · current branch ${result.branch}${result.dirty ? " · local changes preserved" : " · clean checkout"}`,
      }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  };
  const originLabel = (url: string | null) => {
    if (!url) return "None";
    try {
      const identity = remoteIdentity(url);
      return `${identity.owner}/${identity.name}`;
    } catch {
      return url;
    }
  };
  return (
    <div className="page repository-library">
      <div className="page-title">
        <h1>Repositories</h1>
        <div className="spacer" />
        <Button variant="default" onClick={() => setConnection({ path: "" })}>
          <Plus size={14} />
          Connect local repository
        </Button>
        <Button
          disabled={!!busy}
          onClick={() => void action("repositories.scan", {}, "scan")}
        >
          {busy === "scan" ? "Scanning…" : "Scan local"}
        </Button>
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
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {!!snapshot.github?.clones?.length && (
        <section aria-label="Managed clone activity">
          <h2 className="repository-section-title">Managed clones</h2>
          {snapshot.github.clones.map((activity) => (
            <CloneActivity
              key={activity.id}
              activity={activity}
              createTask={createTask}
            />
          ))}
        </section>
      )}
      <section aria-labelledby="active-repositories-title">
        <h2 id="active-repositories-title" className="repository-section-title">
          Active repositories <small>{active.length}</small>
        </h2>
        {!active.length && (
          <div className="repository-empty">
            <strong>No active repositories</strong>
            <p>
              Connect a local Git repository to start working with Vibestar.
            </p>
            <div className="actions">
              <Button
                variant="default"
                onClick={() => setConnection({ path: "" })}
              >
                Connect local repository
              </Button>
              <Button
                disabled={!!busy}
                onClick={() => void action("repositories.scan", {}, "scan")}
              >
                Scan for repositories
              </Button>
            </div>
          </div>
        )}
        {active
          .filter((r) => visible(r.owner + "/" + r.name + " " + r.path))
          .map((r) => (
            <div className="active-repository-row" key={r.id}>
              <div className="active-repository-heading">
                <strong>
                  {r.owner}/{r.name}
                </strong>
                <span className="status-chip success">Active</span>
                <span className="subtle">
                  {r.source === "imported"
                    ? "User-owned checkout"
                    : "Vibestar-managed clone"}
                </span>
              </div>
              <p className="subtle">
                {r.environment === "windows" || r.path?.startsWith("/mnt/")
                  ? "Windows"
                  : "WSL"}{" "}
                ·{" "}
                {r.distro ||
                  snapshot.execution_environment?.distro ||
                  "Configured environment"}
              </p>
              <code className="repository-path">{r.path}</code>
              {r.windows_path && (
                <p className="subtle">Windows: {r.windows_path}</p>
              )}
              <dl className="repository-facts">
                <dt>Upstream</dt>
                <dd>
                  {r.owner}/{r.name}{" "}
                  <small>{r.upstream_remote || "upstream"}</small>
                </dd>
                <dt>Origin / fork</dt>
                <dd>{originLabel(r.origin_url)}</dd>
                <dt>Base</dt>
                <dd>{r.base_branch}</dd>
              </dl>
              <div className="actions">
                <OpenInEditor id={r.id} kind="repository" path={r.path} />
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
                  Open
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void action("repository.fetch", { id: r.id }, r.id)
                  }
                >
                  Fetch
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void verify(r.id)}
                >
                  Verify
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Disconnect " +
                          r.owner +
                          "/" +
                          r.name +
                          "? It will leave the active list. Source files, branches, task history and existing worktrees will be kept. Reconnect this checkout to create new tasks.",
                      )
                    )
                      void action(
                        "repository.disconnect",
                        { id: r.id, confirmed: true },
                        r.id,
                      );
                  }}
                >
                  Disconnect
                </Button>
              </div>
              {verified[r.id] && (
                <p className="success" role="status">
                  {verified[r.id]}
                </p>
              )}
            </div>
          ))}
      </section>
      {!!discovered.length && (
        <section aria-labelledby="discovered-repositories-title">
          <h2
            id="discovered-repositories-title"
            className="repository-section-title"
          >
            Discovered local <small>{discovered.length}</small>
          </h2>
          {discovered.map((r) => (
            <div className="repo-catalog-row" key={r.path}>
              <div>
                <strong>{r.identities.join(" · ") || "Git repository"}</strong>
                <small>{r.path}</small>
                <small>
                  {r.environment === "windows"
                    ? "Windows checkout"
                    : "WSL checkout"}{" "}
                  · Discovered, not connected
                </small>
              </div>
              <div className="spacer" />
              <Button size="sm" onClick={() => setConnection({ path: r.path })}>
                Connect
              </Button>
            </div>
          ))}
        </section>
      )}
      <section aria-labelledby="github-repositories-title">
        <h2 id="github-repositories-title" className="repository-section-title">
          GitHub repositories <small>All</small>
        </h2>
        {!snapshot.github?.status?.connected && (
          <p className="empty-row">
            Connect GitHub in Providers to browse your repositories.
          </p>
        )}
        {rows.map((r) => {
          const managed = snapshot.repositories.find(
            (local) =>
              local.source !== "imported" &&
              `${local.owner}/${local.name}`.toLowerCase() ===
                r.full_name.toLowerCase(),
          );
          const cloning = snapshot.github?.clones?.some(
            (c) =>
              c.repository_id === managed?.id &&
              ["resolving", "cloning"].includes(c.status),
          );
          return (
            <div className="repo-catalog-row" key={r.id}>
              <div>
                <strong>{r.full_name}</strong>
                <small>
                  {r.default_branch} · {r.private ? "private" : "public"}
                </small>
              </div>
              <div className="spacer" />
              <Button
                size="sm"
                disabled={!!busy || cloning}
                onClick={() =>
                  managed?.connected === false
                    ? void action(
                        "repository.reconnectManaged",
                        { id: managed.id },
                        managed.id,
                      )
                    : void find(r.full_name)
                }
              >
                {cloning
                  ? "Cloning…"
                  : busy === r.full_name
                    ? "Finding…"
                    : managed?.connected === false
                      ? "Reconnect managed clone"
                      : "Use repository"}
              </Button>
            </div>
          );
        })}
        {!rows.length && snapshot.github?.status?.connected && (
          <p className="empty-row">
            {query
              ? "No GitHub repositories match your search."
              : "Sync GitHub to load your repository catalog."}
          </p>
        )}
      </section>
      {connection && (
        <ConnectLocalRepository
          distro={
            snapshot.execution_environment?.distro ||
            "Configured WSL distribution"
          }
          initialPath={connection.path}
          close={() => setConnection(undefined)}
          connected={refresh}
        />
      )}
      {candidates && (
        <div className="modal-backdrop">
          <section
            className="modal compact-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Local checkout search"
          >
            <h2>{candidates.repository}</h2>
            {candidates.candidates.length ? (
              candidates.candidates.map((c) => (
                <div className="checkout-candidate" key={c.path}>
                  <code>{c.path}</code>
                  <small>
                    {c.environment === "wsl"
                      ? "WSL checkout"
                      : "Windows checkout"}
                  </small>
                  <Button
                    onClick={() => {
                      setCandidates(undefined);
                      setConnection({ path: c.path });
                    }}
                  >
                    Connect checkout
                  </Button>
                </div>
              ))
            ) : (
              <p>
                No unconnected local checkout was found. You can connect a path
                manually or create a separate Vibestar-managed clone.
              </p>
            )}
            <p className="subtle">
              Clone destination: {snapshot.root}/repos/&lt;managed repository
              ID&gt;. Vibestar owns the new clone; your existing checkouts
              remain user-owned.
            </p>
            <div className="actions">
              <Button
                onClick={() => {
                  setCandidates(undefined);
                  setConnection({ path: "" });
                }}
              >
                Enter local path
              </Button>
              <Button
                disabled={!!busy}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "Create a Vibestar-managed clone under " +
                        snapshot.root +
                        "/repos? This downloads a separate checkout.",
                    )
                  )
                    return;
                  await action(
                    "github.clone",
                    { repository: candidates.repository },
                    "clone",
                  );
                  setCandidates(undefined);
                }}
              >
                Clone with Vibestar
              </Button>
              <Button variant="ghost" onClick={() => setCandidates(undefined)}>
                Cancel
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
