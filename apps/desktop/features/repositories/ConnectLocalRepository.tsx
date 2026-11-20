import { useState } from "react";
import { X, Check } from "lucide-react";

import type { VerifiedLocalRepository } from "../../../core/workspace/discovery";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import type { Repository } from "../../lib/types";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";
import { DiscardChangesDialog } from "../../components/ui/DiscardChangesDialog";
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
  const [confirmClose, setConfirmClose] = useState(false);
  const focus = useDialogFocus();

  const requestClose = () => {
    if (busy) {
      return;
    }

    const dirty =
      path !== initialPath ||
      environment !== initialEnvironment ||
      (verification &&
        (upstream !== (verification.upstream_remote || "") ||
          origin !== (verification.origin_remote || "") ||
          base !== (verification.base_branch || "")));

    if (dirty) {
      setConfirmClose(true);
    } else {
      close();
    }
  };

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
    <div className="modal-backdrop fixed inset-[var(--titlebar-height)_0_0] flex items-center justify-center z-[50]">
      <section
        ref={focus}
        className="modal border border-border-strong p-6 max-w-[94vw] max-h-[90%] overflow-auto [box-shadow:0_12px_45px_var(--overlay)] animate-[surface-enter_var(--motion-enter)_ease-out] compact-dialog repository-connect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-repository-title"
        onKeyDown={(e) => {
          containDialogFocus(e);
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            requestClose();
          }
        }}
      >
        <div className="modal-heading flex items-center justify-between gap-2 mb-[9px]">
          <h2 id="connect-repository-title">Connect local repository</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            disabled={busy}
            onClick={requestClose}
          >
            <X size={16} />
          </Button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!useExisting) {
              void verify();
            }
          }}
        >
          <fieldset className="scope-options p-0 [border:0] mt-[13px] flex flex-wrap gap-[0_15px]">
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
          <div className="verified-repository grid grid-cols-[minmax(0,_1fr)] gap-2.5 border-t border-t-border-default mt-3.5 pt-3">
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
                  if (existing.connected === false) {
                    await rpc("repository.reconnectManaged", { id: existing.id });
                  }

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
          <div className="verified-repository grid grid-cols-[minmax(0,_1fr)] gap-2.5 border-t border-t-border-default mt-3.5 pt-3">
            <h3 className="success">
              <Check size={14} /> Repository verified
            </h3>

            <dl className="repository-facts grid grid-cols-[120px_minmax(0,_1fr)] gap-[6px_12px] mx-0 my-3 text-[12px]">
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
                <div className="contents" key={r.name}>
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
                  if (origin === name) {
                    setOrigin("");
                  }

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
          <p
            className="error-box px-3 py-2 mx-0 my-2 text-[12px] whitespace-pre-wrap wrap-anywhere"
            role="alert"
          >
            {error}
          </p>
        )}
      </section>
      {confirmClose && <DiscardChangesDialog keep={() => setConfirmClose(false)} discard={close} />}
    </div>
  );
};
