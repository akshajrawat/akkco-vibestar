import { useState } from "react";
import { CheckCircle2, GitCommitHorizontal, Settings2, Upload } from "lucide-react";

import type { FinalizationView } from "../../../backend/finalization/contracts";
import { Button } from "../../components/ui/button";
import { errorMessage, rpc } from "../../lib/api";
import type { FinalizationController, GitFinalizationProps } from "./useGitFinalization";
import { FinalizationOptions } from "./FinalizationOptions";
import { GitOperationConfirmation, type Confirmation } from "./GitOperationConfirmation";

/** One commit/push surface; every publication follows a fresh, explicit destination confirmation. */
export const FinalizationCommit = ({
  controller,
  snapshot,
  repository,
  task,
  review,
}: {
  review?: () => void;
  controller: FinalizationController;
  snapshot: NonNullable<FinalizationController["snapshot"]>;
} & Pick<GitFinalizationProps, "repository" | "task">) => {
  const {
    locked,
    preset,
    committed,
    record,
    setBusy,
    setError,
    setNotice,
    message,
    updateMessage,
    selection,
    busy,
    stale,
    perform,
    prepareSelection,
    stagedSelection,
    replaceStaged,
    unresolved,
  } = controller;

  const [optionsOpen, setOptionsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [confirmed, setConfirmed] = useState(false);

  const signature = (id = record?.id) =>
    JSON.stringify({ id, message, preset, selection, fingerprint: snapshot.fingerprint });

  const currentConfirmation = confirmation?.signature === signature() ? confirmation : undefined;

  const destinationUrl =
    preset.remote === (repository?.origin_remote || "origin") && repository?.origin_url
      ? repository.origin_url
      : repository?.upstream_url;

  const destinationLabel =
    destinationUrl
      ?.replace(/^https:\/\/github\.com\//, "")
      .replace(/^git@github\.com:/, "")
      .replace(/\.git$/, "") || "Choose a destination";

  const canCommit =
    !locked &&
    !committed &&
    !unresolved &&
    selection.length > 0 &&
    message.length > 0 &&
    (!stagedSelection || replaceStaged);

  const requestConfirmation = async (kind: Confirmation["kind"]) => {
    setConfirmation(undefined);
    setConfirmed(false);
    let operation = record;
    if (!operation || stale) operation = await prepareSelection();
    if (!operation) return;
    if (
      !operation.head &&
      (operation.review?.approval !== "approved" ||
        !["reviewed", "approved"].includes(operation.status) ||
        operation.verification_gap)
    ) {
      setNotice(
        "This selection needs a fresh review. Open selected changes review before committing.",
      );

      return;
    }

    setBusy(
      kind === "commit"
        ? "Preparing commit confirmation…"
        : "Checking destination, permission and remote head…",
    );

    setError("");
    try {
      const destination =
        kind === "commit"
          ? null
          : await rpc<NonNullable<FinalizationView["destination"]>>("git.checkDestination", {
              id: task.id,
              operation_id: operation.id,
              destination: { remote: preset.remote, branch: preset.branch },
            });

      setConfirmation({ kind, operation, destination, signature: signature(operation.id) });
    } catch (error) {
      setError(errorMessage(error));
      setOptionsOpen(true);
    } finally {
      setBusy("");
    }
  };

  const executeConfirmed = async () => {
    if (!currentConfirmation || !confirmed) return;
    const approved = currentConfirmation;
    setConfirmation(undefined);

    await perform(
      approved.kind === "commit"
        ? "Creating local commit…"
        : approved.kind === "push"
          ? "Pushing reviewed commit…"
          : "Committing and pushing reviewed files…",
      async () => {
        let operation = approved.operation;
        if (!operation.head) {
          if (operation.status === "reviewed")
            operation = await rpc<FinalizationView>("git.approve", {
              id: task.id,
              operation_id: operation.id,
              confirmed: true,
            });

          operation = await rpc<FinalizationView>("git.commit", {
            id: task.id,
            operation_id: operation.id,
            message,
            skip_hooks: preset.commit_hooks === "skip",
            confirmed: true,
          });
        }

        if (approved.kind === "commit") return operation;

        operation = await rpc<FinalizationView>("git.prepare", {
          id: task.id,
          operation_id: operation.id,
          destination: { remote: preset.remote, branch: preset.branch },
        });

        if (JSON.stringify(operation.destination) !== JSON.stringify(approved.destination))
          throw new Error(
            "The destination changed after confirmation. The local commit is preserved. Check and confirm the destination again.",
          );
        return rpc<FinalizationView>("git.publish", {
          id: task.id,
          operation_id: operation.id,
          skip_hooks: preset.push === "skip",
          confirmed: true,
        });
      },
    );
  };

  return (
    <section className="git-commit-panel">
      <h3>
        <GitCommitHorizontal size={16} /> Commit
      </h3>
      <label>
        Commit message
        <textarea
          aria-label="Exact Git commit message"
          rows={4}
          value={message}
          disabled={locked || committed}
          onChange={(event) => updateMessage(event.target.value)}
          placeholder="Describe your changes…"
        />
      </label>
      <div className="actions">
        <Button
          variant="default"
          disabled={!canCommit}
          onClick={() => void requestConfirmation("commit")}
        >
          Commit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOptionsOpen(!optionsOpen)}
          aria-expanded={optionsOpen}
        >
          <Settings2 size={14} /> Options
        </Button>
      </div>
      {committed && (
        <p className="git-commit-success">
          <CheckCircle2 size={15} /> Local commit saved
        </p>
      )}

      <section className="git-publish-panel">
        <h3>
          <Upload size={16} /> Push
        </h3>
        <p className="git-destination-label">
          <strong>{record?.destination?.repository || destinationLabel}</strong>
          <span>{preset.branch}</span>
        </p>
        <div className="actions">
          <Button
            variant={committed ? "default" : "secondary"}
            disabled={
              locked ||
              !committed ||
              stale ||
              preset.push === "none" ||
              record?.status === "published"
            }
            onClick={() => void requestConfirmation("push")}
          >
            Push
          </Button>
          {!committed && (
            <Button
              variant="secondary"
              disabled={!canCommit || preset.push === "none"}
              onClick={() => void requestConfirmation("both")}
            >
              Commit &amp; Push
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOptionsOpen(true)}>
            Configure destination
          </Button>
        </div>
        {record?.status === "published" && (
          <p className="git-commit-success">
            <CheckCircle2 size={15} /> Push verified against the remote branch.
          </p>
        )}
      </section>

      {record &&
        !record.head &&
        (stale || record.review?.approval !== "approved" || record.verification_gap) && (
          <div className="git-review-required">
            <p className="subtle">
              This file selection needs a fresh review before it can be committed.
            </p>
            {review && (
              <Button size="sm" variant="ghost" disabled={locked} onClick={review}>
                Open selected changes review
              </Button>
            )}
          </div>
        )}

      <FinalizationOptions
        controller={controller}
        snapshot={snapshot}
        repository={repository}
        task={task}
        open={optionsOpen}
        onOpenChange={setOptionsOpen}
      />

      {currentConfirmation && (
        <GitOperationConfirmation
          confirmation={currentConfirmation}
          message={message}
          preset={preset}
          confirmed={confirmed}
          setConfirmed={setConfirmed}
          locked={locked}
          onConfirm={() => void executeConfirmed()}
          onCancel={() => setConfirmation(undefined)}
        />
      )}

      {record && ["uncertain", "pushing", "committing", "interrupted"].includes(record.status) && (
        <section className="git-recovery">
          <p className="warning">Reconcile the saved operation before retrying.</p>
          <Button
            disabled={locked}
            onClick={() =>
              void perform("Reconciling saved Git state…", () => controller.call("reconcile"))
            }
          >
            Reconcile state
          </Button>
          {record.status === "interrupted" && record.head && (
            <Button
              disabled={locked}
              onClick={() =>
                void perform("Resuming the saved local commit…", () =>
                  controller.call("resumeCommit", { confirmed: true }),
                )
              }
            >
              Confirm resume local commit
            </Button>
          )}
        </section>
      )}
      {record?.error && (
        <p className="error-box" role="alert">
          {errorMessage(record.error)}
        </p>
      )}
      {busy && (
        <p className="operation-status" role="status">
          {busy}
        </p>
      )}
    </section>
  );
};
