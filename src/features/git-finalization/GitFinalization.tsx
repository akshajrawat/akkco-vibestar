import { GitBranch, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import { ListSkeleton } from "../../components/ui/PageHeader";
import { errorMessage } from "../../lib/api";
import { containDialogFocus } from "../../lib/keyboard";
import { ConnectLocalRepository } from "../repositories/ConnectLocalRepository";
import { FinalizationCommit } from "./FinalizationCommit";
import { FinalizationFiles } from "./FinalizationFiles";
import { SelectionReview } from "./SelectionReview";
import { FinalizationOutput } from "./FinalizationOutput";
import { useGitFinalization, type GitFinalizationProps } from "./useGitFinalization";

/** Presents selected changes and explicit commit/push actions around the guarded core. */
export const GitFinalization = (
  props: GitFinalizationProps & {
    mode?: "git" | "review";
    onModeChange?: (mode: "git" | "review") => void;
  },
) => {
  const { task, repository, close, mode = "git", onModeChange } = props;
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
  } = controller;

  if (connectingFork && repository)
    return (
      <ConnectLocalRepository
        configureRemotes
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
            <h2 id="git-finalization-title">
              <GitBranch size={16} />{" "}
              {mode === "review" ? "Selected changes review" : "Git Changes"}
            </h2>
            <p>
              {mode === "review"
                ? "Inspect and review the exact files you plan to commit."
                : "Select files, commit, then push when ready."}
            </p>
          </div>

          <Button
            variant="ghost"
            size="icon"
            aria-label="Close Git Changes"
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
              <FinalizationFiles controller={controller} snapshot={snapshot} task={task} />
              {mode === "review" ? (
                <SelectionReview controller={controller} />
              ) : (
                <FinalizationCommit
                  controller={controller}
                  snapshot={snapshot}
                  repository={repository}
                  task={task}
                  review={onModeChange ? () => onModeChange("review") : undefined}
                />
              )}
            </div>
            <FinalizationOutput controller={controller} snapshot={snapshot} task={task} />
          </>
        )}

        <footer className="git-finalization-footer">
          <small>
            Task branch <code>{task.branch_name}</code>
          </small>

          <div className="actions">
            {mode === "review" && onModeChange && (
              <Button variant="default" disabled={locked} onClick={() => onModeChange("git")}>
                Back to Git Changes
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
