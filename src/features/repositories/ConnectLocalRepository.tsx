import { useState } from "react";
import { X, Check } from "lucide-react";

import type { VerifiedLocalRepository } from "../../../backend/workspace/discovery";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import type { Repository } from "../../lib/types";
import { Select } from "../../components/ui/Select";

export const ConnectLocalRepository = ({
  distro,
  initialPath = "",
  initialEnvironment = "wsl",
  close,
  connected,
  repositories = [],
  selectRepository,
  configureRemotes = false,
}: {
  distro: string;
  initialPath?: string;
  initialEnvironment?: "wsl" | "windows";
  close: () => void;
  connected: () => Promise<void>;
  repositories?: Repository[];
  selectRepository?: (id: string) => void;
  configureRemotes?: boolean;
}) => {
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [path, setPath] = useState(initialPath);
  const [verification, setVerification] = useState<VerifiedLocalRepository>();
  const [upstream, setUpstream] = useState("");
  const [origin, setOrigin] = useState("");
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [located, setLocated] = useState<Repository | null>(null);

  const existing =
    located ||
    repositories.find((repo) =>
      [repo.path, repo.windows_path].some(
        (location) =>
          location && location.replace(/[\\/]+$/, "") === path.trim().replace(/[\\/]+$/, ""),
      ),
    );

  const useExisting =
    existing &&
    (!configureRemotes || existing.source !== "imported") &&
    (existing.connected !== false || existing.source !== "imported");

  const verify = async () => {
    setBusy(true);
    setError("");
    setVerification(undefined);
    try {
      const known = await rpc<Repository | null>("repository.locateLocal", { environment, path });
      if (
        known?.id &&
        (!configureRemotes || known.source !== "imported") &&
        (known.connected !== false || known.source !== "imported")
      ) {
        setLocated(known);
        return;
      }

      const result = await rpc<VerifiedLocalRepository>("repository.verifyLocal", {
        environment,
        path,
      });

      setVerification(result);
      setUpstream(result.upstream_remote || "");
      setOrigin(result.origin_remote || "");
      setBase(result.base_branch || "");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        className="modal compact-dialog repository-connect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-repository-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) close();
        }}
      >
        <div className="modal-heading">
          <h2 id="connect-repository-title">Connect local repository</h2>
          <Button variant="ghost" size="icon" aria-label="Close" disabled={busy} onClick={close}>
            <X size={16} />
          </Button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!useExisting) void verify();
          }}
        >
          <fieldset className="scope-options">
            <legend>Environment</legend>
            {(["wsl", "windows"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name="repository-environment"
                  checked={environment === value}
                  disabled={busy}
                  onChange={() => {
                    setEnvironment(value);
                    setPath("");
                    setVerification(undefined);
                    setLocated(null);
                    setError("");
                  }}
                />
                {value === "wsl" ? "WSL" : "Windows"}
              </label>
            ))}
          </fieldset>
          <p className="subtle">Execution: {distro}</p>
          <label>
            Path
            <input
              autoFocus
              required
              disabled={busy}
              value={path}
              placeholder={
                environment === "wsl" ? "~/projects/repository" : "D:\\projects\\my-repo"
              }
              onChange={(e) => {
                setPath(e.target.value);
                setVerification(undefined);
                setLocated(null);
                setError("");
              }}
            />
          </label>

          {!useExisting && (
            <Button type="submit" disabled={busy || !path.trim()}>
              {busy ? "Checking…" : "Verify repository"}
            </Button>
          )}
        </form>

        {useExisting && (
          <div className="verified-repository">
            <h3>
              {existing.owner}/{existing.name}
            </h3>
            <p className="subtle">
              {existing.source === "imported" ? "Already connected" : "Vibestar-managed clone"} ·{" "}
              {existing.base_branch}
            </p>
            <Button
              variant="default"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  if (existing.connected === false)
                    await rpc("repository.reconnectManaged", { id: existing.id });
                  await connected();
                  selectRepository?.(existing.id);
                  close();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Select connected repository
            </Button>
          </div>
        )}

        {verification && !useExisting && (
          <div className="verified-repository">
            <h3 className="success">
              <Check size={14} /> Repository verified
            </h3>

            <dl className="repository-facts">
              {verification.windows_path && (
                <>
                  <dt>Windows path</dt>
                  <dd>
                    <code>{verification.windows_path}</code>
                  </dd>
                </>
              )}
              <dt>Execution path</dt>
              <dd>
                <code>{verification.path}</code>
              </dd>
              <dt>Environment</dt>
              <dd>
                {environment === "wsl" ? "WSL" : "Windows"} · {verification.distro}
              </dd>
              <dt>Current branch</dt>
              <dd>{verification.branch}</dd>
              {verification.remotes.map((r) => (
                <div className="repository-remote" key={r.name}>
                  <dt>{r.name}</dt>
                  <dd>
                    {r.identity || "Non-GitHub remote"}
                    <small>{r.url}</small>
                  </dd>
                </div>
              ))}
            </dl>

            <label>
              Upstream repository
              <Select
                label="Upstream repository"
                value={upstream}
                disabled={busy}
                onChange={(name) => {
                  const remote = verification.remotes.find((r) => r.name === name);
                  setUpstream(name);
                  if (origin === name) setOrigin("");
                  setBase(remote?.default_branch || "");
                }}
                options={[
                  { value: "", label: "Select upstream explicitly…" },
                  ...verification.remotes
                    .filter((r) => r.identity)
                    .map((r) => ({ value: r.name, label: r.identity!, description: r.name })),
                ]}
              />
            </label>

            <label>
              Origin / fork
              <Select
                label="Origin / fork"
                value={origin}
                disabled={busy}
                onChange={setOrigin}
                options={[
                  { value: "", label: "None" },
                  ...verification.remotes
                    .filter((r) => r.identity && r.name !== upstream)
                    .map((r) => ({ value: r.name, label: r.identity!, description: r.name })),
                ]}
              />
            </label>

            <label>
              Base branch
              <Select
                label="Base branch"
                value={base}
                disabled={busy}
                onChange={setBase}
                searchable
                options={[
                  { value: "", label: "Select base explicitly…" },
                  ...verification.branches.map((branch) => ({ value: branch, label: branch })),
                ]}
              />
            </label>

            <p className="subtle">
              User-owned checkout
              {verification.dirty ? " · local changes detected and preserved" : ""}. Agents work in
              isolated Vibestar worktrees. Your files, remotes and current branch stay in place.
            </p>

            <Button
              variant="default"
              disabled={busy || !upstream || !base}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await rpc("repository.connectLocal", {
                    verification_id: verification.verification_id,
                    upstream_remote: upstream,
                    origin_remote: origin || null,
                    base_branch: base,
                  });

                  await connected();
                  close();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Connect repository
            </Button>
          </div>
        )}

        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
};
