import type { HistoricalWorkspace } from "../../../backend/flows/workspace";
import type { Detail } from "../../lib/types";
import { useTaskView } from "../../lib/taskView";
import { AgentTimeline } from "../chat/AgentTimeline";
import { HistoricalChecks } from "./HistoricalChecks";

/** Original telemetry is shown as history, without synthesizing graph attempts or approvals. */
export const ImportedHistory = ({
  history,
  detail,
}: {
  history: HistoricalWorkspace;
  detail: Detail;
}) => {
  const local = useTaskView(detail.task.id);
  return (
    <div className="flow-activity">
      <h2>Imported task history</h2>
      {history ? (
        <>
          <p>
            Saved state: {history.migration.original_status} · stage{" "}
            {history.migration.original_stage ?? "unknown"}.
          </p>
          <p>{history.migration.diagnostic}</p>
          {history.definition && (
            <details>
              <summary>
                Original contribution graph · {history.definition.nodes.length} nodes
              </summary>
              <ol>
                {history.definition.nodes.map((node) => {
                  const original = history.nodes.find((entry) => entry.id === node.id);
                  return (
                    <li key={node.id}>
                      <strong>{node.name}</strong> · {node.type}
                      {node.type === "approval" ? (
                        <p>Past approval decision and exact inputs were not recorded.</p>
                      ) : original?.runs.length ? (
                        <ul>
                          {original.runs.map((run) => (
                            <li key={run.id}>
                              {run.status} · {run.provider} · {run.model || "unrecorded model"} ·{" "}
                              {run.started_at}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No retained process record.</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </details>
          )}
        </>
      ) : (
        <p>No fixed workflow was imported. Retained conversations and artifacts are shown below.</p>
      )}
      {(local.draft || local.draftContext.length > 0) && (
        <details open>
          <summary>Unassigned local draft</summary>
          <p>Copy this draft into the Viber you choose. Its conversation was not inferred.</p>
          <pre>{local.draft}</pre>
          {local.draftContext.map((context) => (
            <details key={context.id}>
              <summary>{context.label}</summary>
              <pre>{context.text}</pre>
            </details>
          ))}
        </details>
      )}
      {local.savedInstruction && (
        <details>
          <summary>Saved instruction selection</summary>
          <pre>{local.savedInstruction.content}</pre>
        </details>
      )}
      <AgentTimeline runs={detail.runs} events={detail.events} messages={detail.messages} compact />
      {(detail.tests.length > 0 || !!detail.validation?.checks.length) && (
        <HistoricalChecks detail={detail} />
      )}
      <h3>Retained artifacts</h3>
      {!detail.artifacts.length && <p>No retained artifacts.</p>}
      {detail.artifacts.map((artifact) => (
        <details key={artifact.id}>
          <summary>
            {artifact.kind} · historical stage {artifact.stage} · {artifact.created_at}
          </summary>
          <pre>{artifact.content}</pre>
        </details>
      ))}
    </div>
  );
};
