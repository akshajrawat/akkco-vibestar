import { CheckCircle2, GitCommitHorizontal, Upload } from "lucide-react";
import type { GitPreset } from "../../../backend/finalization/contracts";
import { Button } from "../../components/ui/button";
import { errorMessage, rpc } from "../../lib/api";
import { workflows } from "./presets";
import type { FinalizationController, GitFinalizationProps } from "./useGitFinalization";
/** Renders the commit portion without owning operation authority or duplicating wizard state. */
export const FinalizationCommit = ({
  controller,
  snapshot,
  repository,
  task,
}: {
  controller: Pick<
    FinalizationController,
    | "step"
    | "locked"
    | "setConnectingFork"
    | "preset"
    | "committed"
    | "setPreset"
    | "record"
    | "setConfirmPush"
    | "setBusy"
    | "setError"
    | "setNotice"
    | "setStep"
    | "message"
    | "updateMessage"
    | "selection"
    | "confirmMessage"
    | "setConfirmMessage"
    | "busy"
    | "stale"
    | "commit"
    | "confirmPush"
    | "destinationDirty"
    | "perform"
    | "call"
  >;
  snapshot: NonNullable<FinalizationController["snapshot"]>;
} & Pick<GitFinalizationProps, "repository" | "task">) => {
  const {
    step,
    locked,
    setConnectingFork,
    preset,
    committed,
    setPreset,
    record,
    setConfirmPush,
    setBusy,
    setError,
    setNotice,
    setStep,
    message,
    updateMessage,
    selection,
    confirmMessage,
    setConfirmMessage,
    busy,
    stale,
    commit,
    confirmPush,
    destinationDirty,
    perform,
    call,
  } = controller;
  return (
    <section className="git-commit-panel" hidden={step === 0}>
      <h3>
        <GitCommitHorizontal size={17} />{" "}
        {step === 1 ? "Commit" : step === 2 ? "Publish" : "Confirm"}
      </h3>
      <div hidden={step !== 2}>
        <p>
          Destination repository:{" "}
          <strong>
            {repository?.origin_url?.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "") ||
              "Contribution fork not connected"}
          </strong>
        </p>
        {!repository?.origin_url && (
          <div className="notice">
            <p>Connect your fork to publish. You can still keep a local commit.</p>
            <Button disabled={!repository || locked} onClick={() => setConnectingFork(true)}>
              Connect Fork
            </Button>
          </div>
        )}
        <details>
          <summary>Saved task presets</summary>
          <label>
            Workflow preset
            <select
              aria-label="Git workflow preset"
              value={
                workflows.some((item) => item.name === preset.name)
                  ? preset.name
                  : "Custom safe preset"
              }
              disabled={locked || committed}
              onChange={(event) => {
                const value = workflows.find((item) => item.name === event.target.value);
                if (value) setPreset({ ...preset, ...value });
              }}
            >
              {workflows.map((item) => (
                <option key={item.name}>{item.name}</option>
              ))}
              <option>Custom safe preset</option>
            </select>
          </label>
        </details>
        <div className="git-hook-options">
          <label>
            Publication
            <select
              aria-label="Git push mode"
              value={preset.push}
              disabled={locked || record?.status === "published"}
              onChange={(event) =>
                setPreset({
                  ...preset,
                  name: "Custom safe preset",
                  push: event.target.value as GitPreset["push"],
                })
              }
            >
              <option value="none">Keep local</option>
              <option value="normal">Normal push</option>
              <option value="skip">Skip optional pre-push hooks</option>
            </select>
          </label>
        </div>
        <p className="muted">
          --no-verify skips optional Git checks. Workspace authorization, selected-file review,
          ancestry and remote SHA guards always apply. Normal hooks run in the read-only sandbox;
          hooks that rewrite messages must be resolved explicitly.
        </p>
        {snapshot.hook_configuration === "/dev/null" && (
          <p className="warning-box">
            Repository/worktree configuration disables optional hooks. Mandatory verification and
            publication checks still apply.
          </p>
        )}
        <div className="form-grid" hidden={!repository?.origin_url}>
          <label>
            Target remote
            <input
              aria-label="Git target remote"
              value={preset.remote}
              disabled={
                locked ||
                (!!record && !committed) ||
                (!!record && !["committed", "prepared", "not_published"].includes(record.status))
              }
              onChange={(event) => {
                setPreset({ ...preset, remote: event.target.value });
                setConfirmPush(false);
              }}
            />
          </label>
          <label>
            Target branch
            <input
              aria-label="Git target branch"
              value={preset.branch}
              disabled={
                locked ||
                (!!record && !committed) ||
                (!!record && !["committed", "prepared", "not_published"].includes(record.status))
              }
              onChange={(event) => {
                setPreset({ ...preset, branch: event.target.value });
                setConfirmPush(false);
              }}
            />
          </label>
        </div>
        <Button
          size="sm"
          disabled={locked}
          onClick={async () => {
            setBusy("Saving preset…");
            setError("");
            try {
              await rpc("git.preset", { id: task.id, preset });
              setNotice("Saved this task's typed workflow preset.");
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setBusy("");
            }
          }}
        >
          Save task preset
        </Button>
        <Button
          variant="default"
          disabled={locked || (!repository?.origin_url && preset.push !== "none")}
          onClick={() => setStep(3)}
        >
          Review operation
        </Button>
      </div>
      <div hidden={step !== 1}>
        <label>
          Exact commit message
          <textarea
            aria-label="Exact Git commit message"
            rows={6}
            value={message}
            disabled={locked || committed}
            onChange={(event) => {
              updateMessage(event.target.value);
            }}
            placeholder="Type your own commit message…"
          />
        </label>
        <Button
          variant="ghost"
          size="sm"
          disabled={locked || committed}
          onClick={() => {
            updateMessage(task.issue.body || task.issue.title || "");
          }}
        >
          Use original issue text
        </Button>
        <details>
          <summary>Exact proposed message</summary>
          <pre className="git-exact-message">{message || "No message entered."}</pre>
        </details>
        <details>
          <summary>Advanced commit options</summary>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={preset.commit_hooks === "skip"}
              disabled={locked || committed}
              onChange={(event) =>
                setPreset({
                  ...preset,
                  name: "Custom safe preset",
                  commit_hooks: event.target.checked ? "skip" : "normal",
                })
              }
            />
            Skip optional commit hooks
          </label>
        </details>
        <Button variant="default" disabled={locked || !message.length} onClick={() => setStep(2)}>
          Continue to publish
        </Button>
      </div>
      <div hidden={step !== 3}>
        <p>
          {committed ? "Publish" : "Commit"} {record?.paths.length || selection.length} reviewed
          files
          {preset.push === "none"
            ? " locally"
            : ` and push to ${repository?.origin_url?.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "") || "your contribution fork"}:${preset.branch}`}
          .
        </p>
        <details>
          <summary>Exact commit message</summary>
          <pre className="git-exact-message">{message}</pre>
        </details>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={confirmMessage}
            disabled={locked || committed}
            onChange={(event) => setConfirmMessage(event.target.checked)}
          />
          I confirm this exact message and the approved selected files.
        </label>
        <Button
          variant="default"
          busy={!!busy && busy.startsWith("Creating")}
          disabled={
            locked || stale || record?.status !== "approved" || !message.length || !confirmMessage
          }
          onClick={() => void commit()}
        >
          {preset.push === "none" ? "Confirm local commit" : "Commit and prepare push"}
        </Button>
        {record?.head && (
          <p className="git-commit-success">
            <CheckCircle2 size={16} />
            <span>
              Local commit <code>{record.head}</code>
            </span>
          </p>
        )}
        <section className="git-publish-panel">
          <h3>
            <Upload size={17} /> Publish
          </h3>
          {record?.destination ? (
            <>
              <dl className="repository-facts">
                <dt>Repository</dt>
                <dd>{record.destination.repository}</dd>
                <dt>Upstream</dt>
                <dd>{record.destination.upstream}</dd>
                <dt>Remote</dt>
                <dd>{record.destination.remote}</dd>
                <dt>Branch</dt>
                <dd>
                  <code>{record.destination.branch}</code>
                </dd>
                <dt>GitHub destination</dt>
                <dd>
                  <code>{record.destination.url}</code>
                </dd>
                <dt>Account</dt>
                <dd>{record.destination.viewer}</dd>
                <dt>Expected remote SHA</dt>
                <dd>
                  <code>
                    {/^0+$/.test(record.destination.expected_remote)
                      ? "New branch · must still be absent"
                      : record.destination.expected_remote}
                  </code>
                </dd>
              </dl>
              {record.status === "prepared" && (
                <>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={confirmPush}
                      disabled={locked || destinationDirty}
                      onChange={(event) => setConfirmPush(event.target.checked)}
                    />
                    Publish this exact commit to the repository and branch shown above.
                  </label>
                  <Button
                    variant="default"
                    disabled={
                      locked || stale || destinationDirty || !confirmPush || preset.push === "none"
                    }
                    onClick={() =>
                      void perform("Publishing with mandatory host checks…", () =>
                        call("publish", {
                          skip_hooks: preset.push === "skip",
                          confirmed: true,
                        }),
                      )
                    }
                  >
                    Confirm push
                  </Button>
                </>
              )}
              {record.status === "published" && (
                <p className="git-commit-success">
                  <CheckCircle2 size={16} />
                  Push verified against the remote branch.
                </p>
              )}
            </>
          ) : (
            <p className="muted">
              {repository?.origin_url
                ? `Configured contribution repository: ${repository.origin_url}. Check the live destination after committing.`
                : "Connect a contribution fork in Repositories to enable publication. Local commits remain available."}
            </p>
          )}
          {record &&
            (["committed", "not_published"].includes(record.status) ||
              (record.status === "prepared" && destinationDirty)) && (
              <Button
                disabled={locked || stale}
                onClick={() =>
                  void perform("Checking remote identity, permission and SHA…", () =>
                    call("prepare", {
                      destination: {
                        remote: preset.remote,
                        branch: preset.branch,
                      },
                    }),
                  )
                }
              >
                Check destination for push
              </Button>
            )}
          {record &&
            ["uncertain", "pushing", "committing", "interrupted"].includes(record.status) && (
              <>
                <p className="error-text">Reconcile the saved operation before retrying.</p>
                <Button
                  disabled={locked}
                  onClick={() =>
                    void perform("Reconciling saved Git state…", () => call("reconcile"))
                  }
                >
                  Reconcile state
                </Button>
                {record.status === "interrupted" && record.head && (
                  <Button
                    disabled={locked}
                    onClick={() =>
                      void perform("Resuming the saved local commit…", () =>
                        call("resumeCommit", { confirmed: true }),
                      )
                    }
                  >
                    Confirm resume local commit
                  </Button>
                )}
              </>
            )}
          {record?.error && <p className="error-box">{errorMessage(record.error)}</p>}
        </section>
      </div>
    </section>
  );
};
