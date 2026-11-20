import { CloneActivity } from "./CloneActivity";
import { OpenInEditor } from "../../components/shared/OpenInEditor";
import { useState } from "react";
import { Search, RefreshCw, Plus, MoreHorizontal, X } from "lucide-react";
import type { Snapshot } from "../../lib/types";
import type { LocalRepository } from "../../../core/workspace/discovery";
import { Button } from "../../components/ui/button";
import { rpc, errorMessage } from "../../lib/api";
import { notifications } from "../../lib/notifications";
import { ConnectLocalRepository } from "./ConnectLocalRepository";
import { remoteIdentity } from "../../../core/domain";

export const RepositoryPage = ({
  snapshot,
  refresh,
}: {
  snapshot: Snapshot;
  refresh: () => Promise<void>;
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
  const visible = (text: string) => text.toLowerCase().includes(query.toLowerCase());

  const formatCheckedAge = (timestamp?: string | null) => {
    if (!timestamp) {
      return null;
    }

    const seconds = Math.floor((Date.now() - Date.parse(timestamp)) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }

    if (seconds < 60) {
      return "just now";
    }

    if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m ago`;
    }

    if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)}h ago`;
    }

    return `${Math.floor(seconds / 86400)}d ago`;
  };

  const syncAge = formatCheckedAge(snapshot.github?.last_sync);

  const discovered = (snapshot.repository_index?.repositories || []).filter(
    (r) => !active.some((a) => a.path === r.path) && visible(r.path + " " + r.identities.join(" ")),
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

      notifications.success(
        method === "repositories.scan" ? "Repository scan complete" : "Repository updated",
        { id: "repositories" },
      );
    } catch (e) {
      setError(errorMessage(e));
      notifications.error(errorMessage(e), { id: "repositories" });
    } finally {
      setBusy("");
    }
  };

  const find = async (repository: string) => {
    setBusy(repository);
    setError("");
    try {
      const result = await rpc<{ candidates: LocalRepository[] }>("repositories.candidates", {
        repository,
      });

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
      const result = await rpc<{ branch: string; dirty: boolean }>("repository.verify", { id });

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
    if (!url) {
      return "None";
    }

    try {
      const identity = remoteIdentity(url);
      return `${identity.owner}/${identity.name}`;
    } catch {
      return url;
    }
  };

  return (
    <div className="page px-[clamp(20px,_3vw,_48px)] py-7.5 flex-1 min-h-0 repository-library">
      <div className="repository-toolbar flex items-center flex-wrap gap-[12px_16px]">
        <div className="library-search max-w-[600px] mb-[13px]">
          <Search size={19} aria-hidden="true" />
          <input
            aria-label="Search repositories"
            placeholder="Search repositories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <Button variant="default" onClick={() => setConnection({ path: "" })}>
            <Plus size={14} />
            Connect local repository
          </Button>

          <Button
            busy={busy === "scan"}
            disabled={!!busy}
            onClick={() => void action("repositories.scan", {}, "scan")}
          >
            {busy === "scan" ? "Scanning…" : "Scan local"}
          </Button>
        </div>
      </div>

      {snapshot.github?.phase && (
        <p className="m-0 mb-4 text-accent-blue text-[12px]" role="status">
          {snapshot.github.phase}
        </p>
      )}

      {error && (
        <p
          className="error-box px-3 py-2 mx-0 my-2 text-[12px] whitespace-pre-wrap wrap-anywhere"
          role="alert"
        >
          {error}
        </p>
      )}

      {!!snapshot.github?.clones?.length && (
        <section aria-label="Managed clone activity">
          <h2 className="repository-section-title m-[24px_0_12px] flex items-center gap-2.5 text-ink-secondary uppercase tracking-[0.08em] text-[11px]">
            Managed clones
          </h2>
          {snapshot.github.clones.map((activity) => (
            <CloneActivity key={activity.id} activity={activity} />
          ))}
        </section>
      )}

      <section aria-labelledby="active-repositories-title">
        <h2
          id="active-repositories-title"
          className="repository-section-title m-[24px_0_12px] flex items-center gap-2.5 text-ink-secondary uppercase tracking-[0.08em] text-[11px]"
        >
          Connected repositories <small>{active.length}</small>
        </h2>

        <div className="repository-list-card px-4 py-0 border border-border-subtle">
          {!active.length && (
            <div className="repository-empty p-4 mb-2 border border-border-default">
              <strong>No active repositories</strong>
              <p>Connect a local Git repository to start working with Vibestar.</p>
              <div className="actions flex gap-1.5">
                <Button variant="default" onClick={() => setConnection({ path: "" })}>
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
              <div
                className="active-repository-row p-4 mb-2 border border-border-default grid grid-cols-[minmax(0,_1fr)_auto] [@media(max-width:900px)]:grid-cols-[minmax(0,_1fr)] gap-[6px_24px] [@media(max-width:900px)]:gap-2.5"
                key={r.id}
              >
                <div className="active-repository-heading flex items-center gap-3 flex-wrap">
                  <strong>
                    {r.owner}/{r.name}
                  </strong>
                  <span className="status-chip success">Active</span>
                </div>
                <div className="flex flex-wrap gap-[6px_16px] col-[1] text-[11px]">
                  <span className="subtle">
                    {r.source === "imported" ? "User-owned checkout" : "Vibestar-managed clone"}
                  </span>
                  <span className="subtle">Base {r.base_branch}</span>
                </div>
                <div className="flex items-center gap-2 col-[2] [@media(max-width:900px)]:col-[1] row-[1_/_3] [@media(max-width:900px)]:row-auto">
                  <OpenInEditor id={r.id} kind="repository" path={r.path} />
                  <Button
                    variant="ghost"
                    size="icon"
                    popoverTarget={`repository-details-${r.id}`}
                    aria-label={`Details and actions for ${r.owner}/${r.name}`}
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                </div>

                <div
                  id={`repository-details-${r.id}`}
                  popover="auto"
                  role="dialog"
                  aria-label={`Repository details for ${r.owner}/${r.name}`}
                  className="repository-details-popover"
                >
                  <div className="section-heading">
                    <h2>
                      {r.owner}/{r.name}
                    </h2>

                    <Button
                      variant="ghost"
                      size="icon"
                      popoverTarget={`repository-details-${r.id}`}
                      popoverTargetAction="hide"
                      aria-label="Close repository details"
                    >
                      <X size={16} />
                    </Button>
                  </div>

                  <p className="subtle">
                    {r.environment === "windows" || r.path?.startsWith("/mnt/") ? "Windows" : "WSL"}{" "}
                    ·{" "}
                    {r.distro || snapshot.execution_environment?.distro || "Configured environment"}
                  </p>
                  <code className="block mb-3 wrap-anywhere">{r.path}</code>
                  {r.windows_path && <p className="subtle">Windows: {r.windows_path}</p>}
                  <dl className="repository-facts grid grid-cols-[120px_minmax(0,_1fr)] gap-[6px_12px] mx-0 my-3 text-[12px]">
                    <dt>Upstream</dt>
                    <dd>
                      {r.owner}/{r.name} <small>{r.upstream_remote || "upstream"}</small>
                    </dd>
                    <dt>Origin / fork</dt>
                    <dd>{originLabel(r.origin_url)}</dd>
                    <dt>Base</dt>
                    <dd>{r.base_branch}</dd>
                  </dl>

                  <div className="actions flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() =>
                        void action("open.directory", { id: r.id, kind: "repository" }, r.id)
                      }
                    >
                      Open
                    </Button>

                    <Button
                      size="sm"
                      disabled={!!busy}
                      onClick={() => void action("repository.fetch", { id: r.id }, r.id)}
                    >
                      Fetch
                    </Button>

                    <Button size="sm" disabled={!!busy} onClick={() => void verify(r.id)}>
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
                              "? It will leave the active list. Source files, branches, conversation history and existing worktrees will be kept. Reconnect this checkout to use with Vibers.",
                          )
                        ) {
                          void action("repository.disconnect", { id: r.id, confirmed: true }, r.id);
                        }
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
              </div>
            ))}
        </div>
      </section>

      {!!discovered.length && (
        <section aria-labelledby="discovered-repositories-title">
          <h2
            id="discovered-repositories-title"
            className="repository-section-title m-[24px_0_12px] flex items-center gap-2.5 text-ink-secondary uppercase tracking-[0.08em] text-[11px]"
          >
            Discovered local <small>{discovered.length}</small>
          </h2>

          {discovered.map((r) => (
            <div
              className="repo-catalog-row flex items-center gap-3 px-[5px] py-[11px] border-b border-b-surface-hover"
              key={r.path}
            >
              <div>
                <strong>{r.identities.join(" · ") || "Git repository"}</strong>
                <small>{r.path}</small>
                <small>
                  {r.environment === "windows" ? "Windows checkout" : "WSL checkout"} · Discovered,
                  not connected
                </small>
              </div>
              <div className="flex-1 min-w-0" />
              <Button size="sm" onClick={() => setConnection({ path: r.path })}>
                Connect
              </Button>
            </div>
          ))}
        </section>
      )}

      <section aria-labelledby="github-repositories-title">
        <div className="repository-section-header flex items-center justify-between m-[28px_0_14px_20px]">
          <h2
            id="github-repositories-title"
            className="repository-section-title m-[24px_0_12px] flex items-center gap-2.5 text-ink-secondary uppercase tracking-[0.08em] text-[11px]"
          >
            GitHub repositories <small>All</small>
          </h2>

          <button
            type="button"
            className="ghost-action-button inline-flex items-center gap-1.5 [border:0] px-2.5 py-1.5 text-[12px] font-medium [transition:background_var(--motion-fast),_color_var(--motion-fast)] disabled:opacity-50 focus-visible:[outline:1px_solid_var(--focus-ring)] focus-visible:outline-offset-[2px]"
            disabled={!!busy}
            onClick={() => void action("github.sync", {}, "sync")}
            aria-label={
              busy === "sync" || !!snapshot.github?.phase
                ? "Syncing GitHub repositories"
                : "Sync GitHub repositories"
            }
          >
            <RefreshCw
              size={13}
              className={busy === "sync" || !!snapshot.github?.phase ? "spinning" : ""}
              aria-hidden="true"
            />
            <span>
              {busy === "sync" || !!snapshot.github?.phase
                ? "Syncing…"
                : syncAge
                  ? `Checked ${syncAge}`
                  : "Sync GitHub"}
            </span>
          </button>
        </div>

        <div className="repository-list-card px-4 py-0 border border-border-subtle">
          {rows.map((r) => {
            const connected = active.find(
              (local) => `${local.owner}/${local.name}`.toLowerCase() === r.full_name.toLowerCase(),
            );

            const managed = snapshot.repositories.find(
              (local) =>
                local.source !== "imported" &&
                `${local.owner}/${local.name}`.toLowerCase() === r.full_name.toLowerCase(),
            );

            const cloning = snapshot.github?.clones?.some(
              (c) => c.repository_id === managed?.id && ["resolving", "cloning"].includes(c.status),
            );

            return (
              <div
                className="repo-catalog-row flex items-center gap-3 px-[5px] py-[11px] border-b border-b-surface-hover"
                key={r.id}
              >
                <div>
                  <strong>{r.full_name}</strong>
                  <small>
                    {r.default_branch} · {r.private ? "private" : "public"}
                  </small>
                </div>
                <div className="flex-1 min-w-0" />
                <Button
                  size="sm"
                  disabled={!!busy || cloning || !!connected}
                  onClick={() =>
                    connected
                      ? undefined
                      : managed?.connected === false
                        ? void action("repository.reconnectManaged", { id: managed.id }, managed.id)
                        : void find(r.full_name)
                  }
                >
                  {cloning
                    ? "Cloning…"
                    : busy === r.full_name
                      ? "Finding…"
                      : connected
                        ? "Connected"
                        : managed?.connected === false
                          ? "Reconnect managed clone"
                          : "Use repository"}
                </Button>
              </div>
            );
          })}

          {!rows.length && snapshot.github?.status?.connected && (
            <p className="px-1.5 py-3 text-[12px] text-ink-muted">
              {query
                ? "No GitHub repositories match your search."
                : "Sync GitHub to load your repository catalog."}
            </p>
          )}
        </div>
      </section>

      {connection && (
        <ConnectLocalRepository
          distro={snapshot.execution_environment?.distro || "Configured WSL distribution"}
          initialPath={connection.path}
          repositories={snapshot.repositories}
          close={() => setConnection(undefined)}
          connected={refresh}
        />
      )}

      {candidates && (
        <div className="modal-backdrop fixed inset-[var(--titlebar-height)_0_0] flex items-center justify-center z-[50]">
          <section
            className="modal border border-border-strong p-6 max-w-[94vw] max-h-[90%] overflow-auto [box-shadow:0_12px_45px_var(--overlay)] animate-[surface-enter_var(--motion-enter)_ease-out] compact-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Local checkout search"
          >
            <h2>{candidates.repository}</h2>
            {candidates.candidates.length ? (
              candidates.candidates.map((c) => (
                <div
                  className="checkout-candidate flex flex-col gap-2 px-0 py-3.5 border-b border-b-border"
                  key={c.path}
                >
                  <code>{c.path}</code>
                  <small>{c.environment === "wsl" ? "WSL checkout" : "Windows checkout"}</small>
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
                No unconnected local checkout was found. You can connect a path manually or create a
                separate Vibestar-managed clone.
              </p>
            )}

            <p className="subtle">
              Clone destination: {snapshot.root}/repos/&lt;managed repository ID&gt;. Vibestar owns
              the new clone; your existing checkouts remain user-owned.
            </p>

            <div className="actions flex gap-1.5">
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
                  ) {
                    return;
                  }

                  await action("github.clone", { repository: candidates.repository }, "clone");
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
