import { useState } from "react";
import { Play, SquareTerminal } from "lucide-react";
import type { Detail } from "../lib/types";
import { rpc, errorMessage, parseArgv, duration } from "../lib/api";
import { Status } from "./Status";
import { Button } from "./ui/button";
export const TestsView = ({
  detail,
  onError,
}: {
  detail: Detail;
  onError: (s: string) => void;
}) => {
  const [argv, setArgv] = useState('["git", "status", "--short"]');
  const [busy, setBusy] = useState(false);
  const result = [...detail.artifacts].reverse().find((a) => a.stage === 3);
  const report = result
    ? (JSON.parse(result.content) as Record<string, string[]>)
    : null;
  return (
    <div className="tests-panel">
      <div className="cwd-banner">
        <SquareTerminal size={14} />
        <span>All commands execute in</span>
        <code>{detail.task.worktree_path}</code>
      </div>
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
      <h2>Recorded command executions</h2>
      {detail.tests.map((t) => (
        <details key={t.id} className="test-command">
          <summary>
            <Status status={t.status} />
            <code>{t.command}</code>
            <span>
              exit {t.exit_code ?? "pending"} ·{" "}
              {duration(t.started_at, t.ended_at)}
            </span>
          </summary>
          <h3>stdout</h3>
          <pre>{t.stdout || "(empty)"}</pre>
          <h3>stderr</h3>
          <pre>{t.stderr || "(empty)"}</pre>
        </details>
      ))}
      {detail.tests.length === 0 && (
        <p className="empty-row">
          No recorded commands yet. Provider command events are also available
          in Logs.
        </p>
      )}
    </div>
  );
};
