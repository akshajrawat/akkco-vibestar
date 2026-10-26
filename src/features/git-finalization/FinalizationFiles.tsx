import { FileCheck2, ShieldCheck } from "lucide-react";
import { Button } from "../../components/ui/button";
import { ListSkeleton } from "../../components/ui/PageHeader";
import { rpc } from "../../lib/api";
import type { FinalizationController, GitFinalizationProps } from "./useGitFinalization";
/** Renders the files portion without owning operation authority or duplicating wizard state. */
export const FinalizationFiles = ({
  controller,
  snapshot,
  task,
}: {
  controller: Pick<
    FinalizationController,
    | "preset"
    | "step"
    | "selection"
    | "fileSearch"
    | "setFileSearch"
    | "filteredFiles"
    | "locked"
    | "invalidate"
    | "setSelection"
    | "stagedSelection"
    | "replaceStaged"
    | "setReplaceStaged"
    | "unresolved"
    | "perform"
    | "record"
    | "stale"
    | "call"
    | "detail"
    | "setStep"
  >;
  snapshot: NonNullable<FinalizationController["snapshot"]>;
} & Pick<GitFinalizationProps, "task">) => {
  const {
    preset,
    step,
    selection,
    fileSearch,
    setFileSearch,
    filteredFiles,
    locked,
    invalidate,
    setSelection,
    stagedSelection,
    replaceStaged,
    setReplaceStaged,
    unresolved,
    perform,
    record,
    stale,
    call,
    detail,
    setStep,
  } = controller;
  return (
    <section className="git-files-panel" hidden={step !== 0}>
      <h3>
        <FileCheck2 size={17} /> Changed files{" "}
        <span className="badge">
          {selection.filter((path) => snapshot.files.some((file) => file.path === path)).length}{" "}
          selected
        </span>
      </h3>
      <p className="muted">
        Selections stage into a separate review index. Your task's existing staged changes stay
        intact until you confirm a commit.
      </p>
      <label>
        <span className="sr-only">Search changed files</span>
        <input
          type="search"
          value={fileSearch}
          placeholder="Search changed files…"
          onChange={(event) => setFileSearch(event.target.value)}
        />
      </label>
      <ul className="git-file-list">
        {filteredFiles.map((file) => (
          <li key={file.path} className={file.excluded ? "excluded" : undefined}>
            <label>
              <input
                type="checkbox"
                checked={selection.includes(file.path)}
                disabled={locked || !!file.excluded || file.committed}
                onChange={(event) => {
                  invalidate();
                  setSelection(
                    event.target.checked
                      ? [...selection, file.path]
                      : selection.filter((path) => path !== file.path),
                  );
                }}
              />
              <span>
                <code>
                  {file.old_path ? `${file.old_path} → ` : ""}
                  {file.path}
                </code>
                <small>
                  {file.status} ·{" "}
                  {file.committed
                    ? "Already committed · included"
                    : file.untracked
                      ? "New file"
                      : file.staged
                        ? "Existing staged changes"
                        : "Working change"}{" "}
                  · {file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`} ·
                  +{file.insertions} / −{file.deletions}
                  {file.binary ? " · Binary" : ""}
                </small>
              </span>
            </label>
            {file.excluded && <small className="error-text">{file.excluded}</small>}
          </li>
        ))}
      </ul>
      {fileSearch && !filteredFiles.length && (
        <p className="muted">No matching files. Your selection is preserved.</p>
      )}
      {!snapshot.files.length && (
        <p className="muted">No changed files. Saved operation history remains available below.</p>
      )}
      {!!snapshot.ignored.length && (
        <details>
          <summary>
            Ignored files ({snapshot.ignored.length}
            {snapshot.ignored.length === 200 ? "+" : ""})
          </summary>
          <p className="muted">Ignored files cannot be selected.</p>
          <ul>
            {snapshot.ignored.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {stagedSelection && (
        <label className="inline-check">
          <input
            type="checkbox"
            checked={replaceStaged}
            disabled={locked}
            onChange={(event) => setReplaceStaged(event.target.checked)}
          />
          Use complete selected files instead of their existing staged hunks. Preserve other staged
          files.
        </label>
      )}
      <Button
        variant="secondary"
        disabled={
          locked || !!unresolved || !selection.length || (!!stagedSelection && !replaceStaged)
        }
        onClick={() =>
          void perform("Preparing selected files…", () =>
            rpc("git.preview", {
              id: task.id,
              request_id: crypto.randomUUID(),
              expected_hash: snapshot.fingerprint,
              paths: selection.filter((path) => snapshot.files.some((file) => file.path === path)),
              replace_selected_staged: replaceStaged,
              preset,
            }),
          )
        }
      >
        Prepare staged preview
      </Button>
      {record && (
        <div className="git-selection-review">
          <h4>
            <ShieldCheck size={16} /> Selection review
          </h4>
          <p>
            {record.review
              ? `${record.review_source === "pipeline" ? "Full final review" : "Independent selection review"}: ${record.review.approval.replaceAll("_", " ")}`
              : "This selection needs a fresh independent review. Subsets do not inherit approval for the full patch."}
          </p>
          {record.review && <p>{record.review.summary}</p>}
          {record.verification_gap && <p className="error-box">{record.verification_gap}</p>}
          {stale && (
            <p className="error-text">
              Task contents or index changed. Prepare a new preview before continuing.
            </p>
          )}
          <div className="actions">
            {["draft", "reviewed"].includes(record.status) && (
              <Button
                disabled={locked || stale}
                onClick={() =>
                  void perform("Antigravity is reviewing this selection…", () => call("review"))
                }
              >
                Review selection with Antigravity
              </Button>
            )}
            {record.status === "reviewed" && (
              <Button
                variant="default"
                disabled={
                  locked ||
                  stale ||
                  record.review?.approval !== "approved" ||
                  !!record.verification_gap
                }
                onClick={() =>
                  void perform("Saving manual approval…", () =>
                    call("approve", { confirmed: true }),
                  )
                }
              >
                Approve selected files
              </Button>
            )}
          </div>
          <details>
            <summary>Staged diff</summary>
            {detail ? (
              <>
                {detail.diff_error ? (
                  <p className="error" role="status">
                    Staged preview unavailable: {detail.diff_error}
                  </p>
                ) : (
                  <pre className="git-staged-diff">{detail.diff || "No tree changes."}</pre>
                )}
                {detail.diff_truncated && (
                  <p>Preview truncated. Open Changes to inspect individual files.</p>
                )}
              </>
            ) : (
              <ListSkeleton label="Loading staged diff" />
            )}
          </details>
        </div>
      )}
      <Button
        variant="default"
        disabled={
          locked ||
          !record ||
          !["approved", "committed", "prepared", "published", "not_published"].includes(
            record.status,
          )
        }
        onClick={() => setStep(1)}
      >
        Continue to commit
      </Button>
    </section>
  );
};
