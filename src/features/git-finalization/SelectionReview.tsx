import { ShieldCheck } from "lucide-react";

import { Button } from "../../components/ui/button";
import { ListSkeleton } from "../../components/ui/PageHeader";
import type { FinalizationController } from "./useGitFinalization";

/** Exact subset review remains separate from committing and publication. */
export const SelectionReview = ({ controller }: { controller: FinalizationController }) => {
  const {
    locked,
    record,
    unresolved,
    selection,
    stagedSelection,
    replaceStaged,
    prepareSelection,
    stale,
    perform,
    call,
    detail,
  } = controller;

  return (
    <section className="git-selection-panel">
      <h3>Selected changes</h3>
      <p className="subtle">Review a file subset here before returning to Git Changes to commit.</p>
      <Button
        variant="secondary"
        disabled={
          locked ||
          !!record?.head ||
          !!unresolved ||
          !selection.length ||
          (!!stagedSelection && !replaceStaged)
        }
        onClick={() => void prepareSelection()}
      >
        View diff &amp; review
      </Button>

      {record && (
        <div className="git-selection-review">
          <h4>
            <ShieldCheck size={16} /> Reviewed changes
          </h4>

          <p>
            {record.review
              ? `${record.paths.length} files · ${record.status === "approved" || record.head ? "Approved" : record.review.approval === "approved" ? "Review passed" : record.review.approval.replaceAll("_", " ")}`
              : "This selection needs a fresh independent review."}
          </p>
          {record.review && (
            <details>
              <summary>Review evidence</summary>
              <p>{record.review.summary}</p>
            </details>
          )}
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
    </section>
  );
};
