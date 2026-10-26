import { useEffect, useState } from "react";

import type { Task } from "../../lib/types";
import type {
  BrowserEnvironmentReport,
  VerificationEnvironment,
} from "../../../backend/execution/verification/browser/contracts";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";

export const BrowserEnvironment = ({
  task,
  unavailable,
  onError,
}: {
  task: Task;
  unavailable: boolean;
  onError: (message: string) => void;
}) => {
  const current = task.verification_environment || "isolated";
  const [environment, setEnvironment] = useState<VerificationEnvironment>(current);
  const [busy, setBusy] = useState("");
  const [report, setReport] = useState(task.browser_environment_report);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setEnvironment(current);
  }, [current, task.id]);

  useEffect(() => {
    setReport(task.browser_environment_report);
  }, [task.id, task.browser_environment_report]);

  const act = async (configure: boolean) => {
    setBusy(configure ? "configure" : "inspect");
    setNotice("");
    try {
      if (configure) {
        await rpc("task.browser.configure", {
          id: task.id,
          environment,
          confirmed: true,
        });

        setReport(undefined);
        setNotice("Verification environment saved. Run missing checks explicitly.");
      } else
        setReport(
          await rpc<BrowserEnvironmentReport>("task.browser.inspect", {
            id: task.id,
          }),
        );
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy("");
    }
  };

  return (
    <details className="browser-environment">
      <summary>Browser verification environment</summary>
      <p>
        Inspect packages, browser launch, registry DNS and loopback sockets in the manual task
        sandbox. This probe does not run your application tests.
      </p>

      <label>
        Verification environment
        <select
          aria-label="Verification environment"
          value={environment}
          disabled={!!busy || unavailable}
          onChange={(event) => setEnvironment(event.target.value as VerificationEnvironment)}
        >
          <option value="isolated">Isolated task sandbox</option>
          <option value="installed_browsers">Task sandbox with installed browsers</option>
        </select>
      </label>

      {environment === "installed_browsers" && (
        <p className="subtle">
          Apply to authorize read-only access to the installed Chrome directory and Playwright
          browser cache for this task's manual verification commands. Agent and terminal profiles
          keep their current mounts.
        </p>
      )}

      <div className="actions">
        <Button
          size="sm"
          busy={busy === "configure"}
          disabled={!!busy || unavailable || environment === current}
          onClick={() => void act(true)}
        >
          Use environment
        </Button>

        <Button
          size="sm"
          variant="outline"
          busy={busy === "inspect"}
          disabled={!!busy || unavailable || environment !== current || !task.worktree_path}
          onClick={() => void act(false)}
        >
          {busy === "inspect" ? "Inspecting environment…" : "Inspect browser environment"}
        </Button>
      </div>

      {notice && (
        <p role="status" className="subtle">
          {notice}
        </p>
      )}

      {report && (
        <div className="browser-capabilities" aria-label="Observed browser capabilities">
          <p>{report.note}</p>
          {(!report.packages.length || !report.browsers.length) && (
            <p className="warning">
              Browser checks unavailable:{" "}
              {!report.packages.length ? "Playwright package not found in task dependencies. " : ""}
              {!report.browsers.length
                ? "No browser executable is exposed in this environment. "
                : ""}
              {report.dns.outcome === "blocked"
                ? "Registry DNS lookup failed; resolve it before attempting installation."
                : "Reuse an installed toolchain or run project setup explicitly when needed."}
            </p>
          )}

          <dl>
            {(
              [
                ["Registry DNS", report.dns],
                ["Listening socket", report.socket],
                ["Direct-file browser loading", report.direct_file],
                ["HTTP browser loading", report.http],
              ] as const
            ).map(([label, observation]) => (
              <div key={label}>
                <dt>
                  {label}
                  <span className={observation.outcome === "available" ? "success" : "warning"}>
                    {observation.outcome}
                  </span>
                </dt>
                <dd>{observation.detail}</dd>
              </div>
            ))}
          </dl>

          <details>
            <summary>Detected toolchain and timestamp</summary>
            <p>
              {report.packages.map((entry) => `${entry.name}: ${entry.path}`).join("\n") ||
                "No Playwright package detected"}
            </p>
            <p>{report.browsers.join("\n") || "No exposed browser detected"}</p>
            <time>{new Date(report.checked_at).toLocaleString()}</time>
          </details>

          <p className="subtle">
            Successful capability probes do not mark blocked, optional or required application
            checks as passed. Rerun the exact missing checks using the manual command form.
          </p>
        </div>
      )}
    </details>
  );
};
