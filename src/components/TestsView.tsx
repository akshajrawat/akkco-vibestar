import { useState } from "react";
import { Play, SquareTerminal } from "lucide-react";
import type { Detail } from "../lib/types";
import { rpc, errorMessage, parseArgv } from "../lib/api";
import { CommandRuns } from "./CommandRuns";
import { Button } from "./ui/button";
import { VerificationSummary } from "./VerificationSummary";
export const TestsView = ({
  detail,
  onError,
  terminal,
}: {
  detail: Detail;
  onError: (s: string) => void;
  terminal?: () => void;
}) => {
  const [argv, setArgv] = useState('["git", "status", "--short"]');
  const [busy, setBusy] = useState(false);
  const [commandId, setCommandId] = useState("");
  const result = [...detail.artifacts]
    .reverse()
    .find((a) => a.stage === 3 && a.kind === "plan");
  const finalReview = [...detail.artifacts]
    .reverse()
    .find((a) => a.stage === 5 && a.kind === "plan");
  const review = finalReview
    ? (JSON.parse(finalReview.content) as Record<string, string[]>)
    : null;
  const report = result
    ? (JSON.parse(result.content) as Record<string, string[]>)
    : null;
  return (
    <div className="tests-panel">
      <VerificationSummary
        detail={detail}
        inspect={setCommandId}
        terminal={terminal}
        retry={
          detail.task.stage === 4 &&
          !detail.active &&
          !detail.executing &&
          !busy
            ? () => {
                setBusy(true);
                void rpc("task.retry", { id: detail.task.id, stage: 4 })
                  .catch((e) => onError(errorMessage(e)))
                  .finally(() => setBusy(false));
              }
            : undefined
        }
      />
      <div className="cwd-banner">
        <SquareTerminal size={14} />
        <span>All commands execute in</span>
        <code>{detail.task.worktree_path}</code>
      </div>
      {detail.task.runtime && (
        <details
          className="runtime-summary"
          open={detail.task.runtime.warnings.length > 0 || undefined}
        >
          <summary>Task runtime</summary>
          <p>
            Python:{" "}
            <code>{detail.task.runtime.python || "System interpreter"}</code>
          </p>
          <p>
            Read-only source dependencies:{" "}
            {detail.task.runtime.dependencies.join(", ") || "None connected"}
          </p>
          {detail.task.runtime.warnings.map((warning) => (
            <p className="warning" key={warning}>
              {warning}
            </p>
          ))}
          <p className="subtle">
            Skipped checks have not passed. Missing dependencies and blocked
            commands remain unverified.
          </p>
        </details>
      )}
      <details className="manual-command">
        <summary>Run a validation command</summary>
        <form
          className="command-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await rpc("task.command", {
                id: detail.task.id,
                argv: parseArgv(argv),
              });
            } catch (e) {
              onError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Manual command · executable and argv JSON
            <input
              className="mono"
              value={argv}
              onChange={(e) => setArgv(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy}>
            <Play size={12} />
            {busy ? "Running…" : "Run in worktree"}
          </Button>
        </form>
      </details>
      <CommandRuns key={commandId} detail={detail} selectedId={commandId} />
      <details className="provider-test-reports">
        <summary>Agent verification reports</summary>
        {report && (
          <div className="test-report">
            {(["testsPassed", "testsFailed", "testsSkipped"] as const).map(
              (key) => (
                <section key={key}>
                  <h3>
                    {key === "testsPassed"
                      ? "Passed"
                      : key === "testsFailed"
                        ? "Failed"
                        : "Skipped"}{" "}
                    <small>provider reported</small>
                  </h3>
                  {report[key]?.length ? (
                    report[key].map((test, i) => <p key={i}>{test}</p>)
                  ) : (
                    <p className="subtle">None reported</p>
                  )}
                </section>
              ),
            )}
          </div>
        )}
        {review && (
          <div className="test-report">
            {(["testsRun", "testsNotRun"] as const).map((key) => (
              <section key={key}>
                <h3>
                  Final review · {key === "testsRun" ? "Executed" : "Not run"}{" "}
                  <small>provider reported</small>
                </h3>
                {review[key]?.length ? (
                  review[key].map((test, i) => <p key={i}>{test}</p>)
                ) : (
                  <p className="subtle">None reported</p>
                )}
              </section>
            ))}
          </div>
        )}
      </details>
    </div>
  );
};
