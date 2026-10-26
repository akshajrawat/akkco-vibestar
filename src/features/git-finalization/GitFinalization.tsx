import { GitBranch, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import { ListSkeleton } from "../../components/ui/PageHeader";
import { errorMessage } from "../../lib/api";
import { containDialogFocus } from "../../lib/keyboard";
import { ConnectLocalRepository } from "../repositories/ConnectLocalRepository";
import { FinalizationCommit } from "./FinalizationCommit";
import { FinalizationFiles } from "./FinalizationFiles";
import { FinalizationOutput } from "./FinalizationOutput";
import { useGitFinalization, type GitFinalizationProps } from "./useGitFinalization";

/** Composes the existing Files, Commit, Publish and Confirm journey around one task-local controller. */
export const GitFinalization = (props: GitFinalizationProps) => {
  const { task, repository, close, complete } = props;
  const controller = useGitFinalization(props);

  const {
    connectingFork,
    setConnectingFork,
    load,
    dialog,
    locked,
    error,
    notice,
    taskView,
    snapshot,
    setError,
    step,
    record,
    setStep,
    setBusy,
  } = controller;

  if (connectingFork && repository)
    return (
      <ConnectLocalRepository
        initialPath={repository.path}
        distro={repository.distro || "Linux"}
        close={() => setConnectingFork(false)}
        connected={async () => {
          setConnectingFork(false);
          await load();
        }}
      />
    );

  return (
    <div className="modal-backdrop">
      <section
        className="modal git-finalization"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-finalization-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !locked) close();
          containDialogFocus(event);
        }}
      >
        <header className="git-finalization-header">
          <div>
            <span className="eyebrow">
              <GitBranch size={14} /> TASK DELIVERY
            </span>
            <h2 id="git-finalization-title">Git Finalization</h2>
            <p>Select reviewed files, keep your exact message and confirm the destination.</p>
          </div>

          <Button
            variant="ghost"
            size="icon"
            aria-label="Close Git Finalization"
            disabled={locked}
            onClick={close}
          >
            <X size={18} />
          </Button>
        </header>

        <details className="git-workspace-details">
          <summary>Workspace identity</summary>
          <dl className="repository-facts">
            <dt>Source checkout</dt>
            <dd>
              <code>{repository?.path || "Unavailable"}</code>
            </dd>
            <dt>Task worktree</dt>
            <dd>
              <code>{task.worktree_path}</code>
            </dd>
            <dt>Task branch</dt>
            <dd>
              <code>{task.branch_name}</code>
            </dd>
            <dt>Pinned base</dt>
            <dd>
              <code>{task.base_commit_sha}</code>
            </dd>
          </dl>
        </details>

        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}

        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        {taskView.persistenceError && (
          <p className="error-box" role="alert">
            {taskView.persistenceError}
          </p>
        )}

        {!snapshot ? (
          <>
            <ListSkeleton label="Loading changed files and Git history" />
            {error && (
              <Button onClick={() => void load().catch((error) => setError(errorMessage(error)))}>
                Retry loading files
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="git-finalization-grid">
              <nav className="git-journey" aria-label="Git Finalization steps">
                {["Files", "Commit", "Publish", "Confirm"].map((label, index) => (
                  <Button
                    key={label}
                    variant={step === index ? "secondary" : "ghost"}
                    aria-current={step === index ? "step" : undefined}
                    disabled={locked || (index > 0 && !record)}
                    onClick={() => setStep(index)}
                  >
                    {index + 1}. {label}
                  </Button>
                ))}
              </nav>
              <FinalizationFiles controller={controller} snapshot={snapshot} task={task} />
              <FinalizationCommit
                controller={controller}
                snapshot={snapshot}
                repository={repository}
                task={task}
              />
            </div>
            <FinalizationOutput controller={controller} snapshot={snapshot} task={task} />
          </>
        )}

        <footer className="git-finalization-footer">
          <small>
            Task branch <code>{task.branch_name}</code>
          </small>

          <div className="actions">
            {task.status === "ready_for_review" && !record?.head && (
              <Button
                disabled={locked}
                onClick={async () => {
                  setBusy("Marking task complete…");
                  try {
                    await complete();
                    close();
                  } catch (error) {
                    setError(errorMessage(error));
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Mark task complete
              </Button>
            )}

            <Button variant="secondary" disabled={locked} onClick={close}>
              Keep local and close
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
};
