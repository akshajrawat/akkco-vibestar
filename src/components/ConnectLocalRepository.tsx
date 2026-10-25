import { useState } from "react";
import { X, Check } from "lucide-react";
import type { VerifiedLocalRepository } from "../../backend/workspace/discovery";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";

export const ConnectLocalRepository = ({
  distro,
  initialPath = "",
  initialEnvironment = "wsl",
  close,
  connected,
}: {
  distro: string;
  initialPath?: string;
  initialEnvironment?: "wsl" | "windows";
  close: () => void;
  connected: () => Promise<void>;
}) => {
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [path, setPath] = useState(initialPath);
  const [verification, setVerification] = useState<VerifiedLocalRepository>();
  const [upstream, setUpstream] = useState("");
  const [origin, setOrigin] = useState("");
  const [base, setBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const verify = async () => {
    setBusy(true);
    setError("");
    setVerification(undefined);
    try {
      const result = await rpc<VerifiedLocalRepository>(
        "repository.verifyLocal",
        { environment, path },
      );
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
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            disabled={busy}
            onClick={close}
          >
            <X size={16} />
          </Button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
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
                environment === "wsl"
                  ? "~/projects/repository"
                  : "D:\\projects\\my-repo"
              }
              onChange={(e) => {
                setPath(e.target.value);
                setVerification(undefined);
                setError("");
              }}
            />
          </label>
          <Button type="submit" disabled={busy || !path.trim()}>
            {busy ? "Checking…" : "Verify repository"}
          </Button>
        </form>
        {verification && (
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
                {environment === "wsl" ? "WSL" : "Windows"} ·{" "}
                {verification.distro}
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
              <select
                required
                value={upstream}
                disabled={busy}
                onChange={(e) => {
                  const remote = verification.remotes.find(
                    (r) => r.name === e.target.value,
                  );
                  setUpstream(e.target.value);
                  if (origin === e.target.value) setOrigin("");
                  setBase(remote?.default_branch || "");
                }}
              >
                <option value="">Select upstream explicitly…</option>
                {verification.remotes
                  .filter((r) => r.identity)
                  .map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.identity} · {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Origin / fork
              <select
                value={origin}
                disabled={busy}
                onChange={(e) => setOrigin(e.target.value)}
              >
                <option value="">None</option>
                {verification.remotes
                  .filter((r) => r.identity && r.name !== upstream)
                  .map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.identity} · {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Base branch
              <select
                required
                value={base}
                disabled={busy}
                onChange={(e) => setBase(e.target.value)}
              >
                <option value="">Select base explicitly…</option>
                {verification.branches.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
            <p className="subtle">
              User-owned checkout
              {verification.dirty
                ? " · local changes detected and preserved"
                : ""}
              . Agents work in isolated Vibestar worktrees. Your files, remotes
              and current branch stay in place.
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
