import { useState } from "react";

import type { Detail } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { detailVerification } from "../../lib/verification";
import { verificationRecoveryChecks } from "../../../backend/execution/verification/verification-recovery";
import type { Engine } from "../../../backend/execution/engine";
import { Button } from "../../components/ui/button";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";
import { BrowserEnvironment } from "./BrowserEnvironment";

const RecoveryDialog = ({
  detail,
  kind,
  close,
  onError,
  prepare,
}: {
  detail: Detail;
  kind: "checks" | "review" | "fix" | "policy";
  close: () => void;
  onError: (message: string) => void;
  prepare: () => void;
}) => {
  const dialog = useDialogFocus();
  const [preview, setPreview] = useState<Awaited<ReturnType<Engine["reviewGapsPreview"]>>>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [instructions, setInstructions] = useState("");

  const pending = detail.messages.filter((message) =>
    ["draft", "queued"].includes(message.status || ""),
  );

  const artifact = [...detail.artifacts]
    .reverse()
    .find((entry) => entry.stage === 3 && entry.kind === "plan");

  const verification = detailVerification(detail);

  const policy =
    detail.task.verification_policy === "repository" ? "extended_browser" : "repository";

  const recovery = verificationRecoveryChecks(verification, {
    selected: detail.task.verification_environment,
    report: detail.task.browser_environment_report,
  });

  const checks = recovery.filter((check) => check.argv);
  const unavailableChecks = recovery.filter((check) => !check.argv);

  const browserChecks = verification.checks.some((check) =>
    /browser|playwright|puppeteer|chromium/i.test(
      `${check.name} ${check.command} ${check.prerequisite}`,
    ),
  );

  const act = async (operation: () => Promise<unknown>, dismiss = true) => {
    setBusy(true);
    try {
      await operation();
      if (dismiss) close();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const title =
    kind === "policy"
      ? "Verification policy"
      : kind === "review"
        ? "Review with verification gaps"
        : kind === "fix"
          ? "Fix with Codex"
          : checks.length
            ? "Run missing checks"
            : "Prepare missing checks";

  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal verification-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(event) => {
          containDialogFocus(event);
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            close();
          }
        }}
      >
        <h2>{title}</h2>
        {kind === "policy" ? (
          <>
            <p>
              {policy === "repository"
                ? "Use repository and issue checks. Extra manual browser checks and setup observations that are not needed by required checks will be optional."
                : "Restore the original required status of the additional manual checks."}
            </p>

            <p>
              Repository automated tests, explicit issue acceptance checks and actual failures
              remain required. Skipped checks stay recorded as unexecuted.
            </p>

            <ul>
              {verification.optionalCandidates.map((check, index) => (
                <li key={index}>{check.name}</li>
              ))}
            </ul>

            <Button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  rpc("task.verification.policy", {
                    id: detail.task.id,
                    policy,
                    confirmed: true,
                  }),
                )
              }
            >
              {policy === "repository"
                ? "Use repository checks and skip extra manual checks"
                : "Restore additional required checks"}
            </Button>

            <p className="subtle">
              Rechecks saved tool results and diff hygiene. Keeps the existing independent review
              and starts no agent.
            </p>
          </>
        ) : kind === "checks" ? (
          <>
            <p>
              {checks.length
                ? "Select a recorded check to execute in the task's selected verification environment."
                : "Each missing check needs an executable command and available prerequisites before it can run."}
            </p>

            {checks.length > 0 &&
              checks.map((check) => (
                <article key={check.command}>
                  <strong>{check.name}</strong>
                  <pre>{JSON.stringify(check.argv)}</pre>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () =>
                          rpc("task.verification.run", {
                            id: detail.task.id,
                            command: check.command,
                          }),
                        false,
                      )
                    }
                  >
                    Run {check.name}
                  </Button>
                </article>
              ))}

            {unavailableChecks.length > 0 && (
              <>
                <p className="warning">
                  {checks.length
                    ? "These requirements are not ready to run."
                    : "No missing check is ready to run yet."}{" "}
                  Recheck saved evidence only reruns diff hygiene; it does not create test commands
                  or repair the environment.
                </p>

                <Button disabled={busy} onClick={prepare}>
                  Prepare runnable checks with Codex
                </Button>

                <p className="subtle">
                  Review and authorize one Codex iteration to create missing test commands. Browser
                  checks remain unverified until they actually run.
                </p>

                <ul>
                  {unavailableChecks.map((check, index) => (
                    <li key={index}>
                      <strong>{check.name}</strong>
                      <p>{check.reason}</p>
                    </li>
                  ))}
                </ul>

                {browserChecks && (
                  <BrowserEnvironment
                    task={detail.task}
                    unavailable={busy || !!detail.active || !!detail.executing}
                    onError={onError}
                  />
                )}
              </>
            )}
            {recovery.length === 0 && <p>There are no outstanding required checks to rerun.</p>}
          </>
        ) : kind === "fix" ? (
          <>
            <p>
              Authorize one Codex iteration in this task's original worktree. Codex receives the
              exact command failures, outstanding checks and final review findings.
            </p>

            <p>
              When checks have no runnable command, Codex prepares repeatable test scripts and
              records their exact commands and prerequisites.
            </p>

            <ul>
              {verification.checks
                .filter((check) => check.required && check.outcome !== "passed")
                .map((check, index) => (
                  <li key={index}>
                    {check.name} · {check.outcome.replaceAll("_", " ")}
                  </li>
                ))}
            </ul>

            <p>
              Codex must investigate prerequisites before retrying an unsuccessful installation.
              Further agent iterations require another explicit request.
            </p>

            <Button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  rpc("task.verification.fix", {
                    id: detail.task.id,
                    request_id: requestId,
                  }),
                )
              }
            >
              Authorize one Codex fix
            </Button>
          </>
        ) : (
          <>
            <p>
              Inspect the implementation and outstanding checks before authorizing independent
              Antigravity review. Required unexecuted checks remain unverified.
            </p>

            {!preview ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(
                    async () =>
                      setPreview(
                        await rpc("task.verification.reviewPreview", {
                          id: detail.task.id,
                        }),
                      ),
                    false,
                  )
                }
              >
                Inspect current gaps
              </Button>
            ) : (
              <>
                <ul>
                  {preview.checks.map((check, index) => (
                    <li key={index}>
                      <strong>{check.name}</strong>
                      <p>{check.environment || check.detail}</p>
                      {check.command && <code>{check.command}</code>}
                    </li>
                  ))}
                </ul>

                {pending.length > 0 && (
                  <label>
                    Saved instructions
                    <select
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                    >
                      <option value="">
                        Choose what to do with {pending.length} saved instructions
                      </option>
                      <option value="keep_saved">Keep saved</option>
                      <option value="include_next_stage">Include in independent review</option>
                    </select>
                  </label>
                )}

                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  I reviewed the implementation and acknowledge these verification gaps.
                </label>

                <p className="subtle">
                  Code approval with gaps keeps changes locally. Git Finalization remains
                  unavailable until required checks pass.
                </p>

                <Button
                  disabled={
                    busy ||
                    !preview.eligible ||
                    !acknowledged ||
                    !artifact ||
                    (pending.length > 0 && !instructions)
                  }
                  onClick={() =>
                    void act(() =>
                      rpc("task.verification.continueReview", {
                        id: detail.task.id,
                        artifact_id: artifact!.id,
                        acknowledge_gaps: true,
                        fingerprint: preview.fingerprint,
                        evidence_hash: preview.evidence_hash,
                        ...(pending.length
                          ? {
                              instructions: {
                                disposition: instructions,
                                message_ids: pending.map((message) => message.id),
                              },
                            }
                          : {}),
                      }),
                    )
                  }
                >
                  Approve implementation & start independent review
                </Button>
              </>
            )}
          </>
        )}

        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={close}>
            Close
          </Button>
        </div>
      </section>
    </div>
  );
};

export const VerificationRecovery = ({
  detail,
  onError,
  inspect,
  disabled = false,
}: {
  detail: Detail;
  onError: (message: string) => void;
  inspect?: () => void;
  disabled?: boolean;
}) => {
  const [kind, setKind] = useState<"checks" | "review" | "fix" | "policy">();
  const [busy, setBusy] = useState(false);
  const verification = detailVerification(detail);

  const recovery = verificationRecoveryChecks(verification, {
    selected: detail.task.verification_environment,
    report: detail.task.browser_environment_report,
  });

  const runnable = recovery.some((check) => check.argv);
  const unavailable = disabled || busy || !!detail.active || !!detail.executing;

  const boundary =
    (detail.task.stage === 4 && detail.task.status === "verification_blocked") ||
    detail.task.approval_gate === "implementation";

  const actions = [
    {
      id: "checks",
      label: runnable ? "Run missing checks" : "Prepare missing checks",
      available: recovery.length > 0,
      run: () => setKind("checks"),
    },
    {
      id: "fix",
      label: "Fix with Codex",
      available: true,
      run: () => setKind("fix"),
    },
    {
      id: "review",
      label: "Continue to independent review",
      available: boundary && verification.canReviewWithGaps,
      run: () => setKind("review"),
    },
    {
      id: "policy",
      label:
        detail.task.verification_policy === "repository"
          ? "Verification policy"
          : "Skip extra manual browser checks",
      available: verification.optionalCandidates.length > 0,
      run: () => setKind("policy"),
    },
    {
      id: "inspect",
      label: "Inspect blockers",
      available: !!inspect,
      run: () => inspect?.(),
    },
    {
      id: "recheck",
      label: "Recheck saved evidence",
      available: true,
      run: () => {
        setBusy(true);

        void rpc("task.verification.recheck", { id: detail.task.id })
          .catch((error) => onError(errorMessage(error)))
          .finally(() => setBusy(false));
      },
    },
  ].filter((action) => action.available);

  const primary =
    verification.outcome === "failed" || detail.task.final_review_verdict === "changes_requested"
      ? "fix"
      : recovery.length
        ? "checks"
        : boundary && verification.canReviewWithGaps
          ? "review"
          : "recheck";

  const renderAction = (action: (typeof actions)[number]) => (
    <Button
      key={action.id}
      size="sm"
      variant={action.id === primary ? "default" : "ghost"}
      disabled={unavailable}
      onClick={action.run}
    >
      {action.label}
    </Button>
  );

  return (
    <div className="verification-recovery">
      {verification.canReview &&
        ["verification_blocked", "reviewed_with_gaps"].includes(detail.task.status) && (
          <p className="success">
            Required checks passed. Recheck saved evidence to open implementation approval.
          </p>
        )}

      <div className="actions">
        {actions.filter((action) => action.id === primary).map(renderAction)}
      </div>

      <details>
        <summary>More options</summary>
        <div className="actions">
          {actions.filter((action) => action.id !== primary).map(renderAction)}
        </div>
      </details>

      {kind && (
        <RecoveryDialog
          key={kind}
          detail={detail}
          kind={kind}
          close={() => setKind(undefined)}
          onError={onError}
          prepare={() => setKind("fix")}
        />
      )}
    </div>
  );
};
