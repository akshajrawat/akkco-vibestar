import type {
  AgentProfile,
  FlowDefinition,
  FlowNode,
  InputBindingSchema,
} from "../../../backend/flows/contracts";
import type { NodeAttempt } from "../../../backend/flows/run-contracts";
import type { z } from "zod";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { predecessors } from "./graph";

export type FlowInputChoice = { binding: z.infer<typeof InputBindingSchema>; title: string };

export const FlowInspector = ({
  node,
  graph,
  profiles,
  attempt,
  update,
  duplicate,
  remove,
  run,
  retry,
  approve,
  activity,
  chat,
  editProfile,
  controlsDisabled,
  activityPreview,
  contextChoices = [],
}: {
  node: FlowNode;
  graph: FlowDefinition;
  profiles: AgentProfile[];
  attempt?: NodeAttempt;
  update: (node: FlowNode) => void;
  duplicate: () => void;
  remove: () => void;
  run: () => void;
  retry: () => void;
  approve: (decision: "accepted" | "rejected") => void;
  activity: () => void;
  chat?: () => void;
  editProfile: (profile: AgentProfile) => void;
  controlsDisabled: boolean;
  activityPreview?: ReactNode;
  contextChoices?: FlowInputChoice[];
}) => {
  const profile =
    node.type === "agent" ? profiles.find((item) => item.id === node.profile_id) : undefined;

  const execution =
    node.type === "agent" && profile ? { ...profile.execution, ...node.overrides } : undefined;

  const ancestors = predecessors(graph, node.id);

  const binding = (input: z.infer<typeof InputBindingSchema>, title: string) => {
    const selected = node.inputs.some((item) => JSON.stringify(item) === JSON.stringify(input));
    return (
      <label key={JSON.stringify(input)} className="viber-checkbox">
        <input
          type="checkbox"
          checked={selected}
          onChange={() =>
            update({
              ...node,
              inputs: selected
                ? node.inputs.filter((item) => JSON.stringify(item) !== JSON.stringify(input))
                : [...node.inputs, input],
            })
          }
        />
        {title}
      </label>
    );
  };

  const override = (value: Partial<NonNullable<typeof execution>>) => {
    if (node.type === "agent") update({ ...node, overrides: { ...node.overrides, ...value } });
  };

  return (
    <aside className="flow-inspector" aria-label="Node inspector">
      <div className="flow-inspector-heading">
        <span>INSPECTOR</span>
        <small>{node.type}</small>
      </div>
      <label>
        Name
        <input
          value={node.name}
          maxLength={100}
          onChange={(event) => update({ ...node, name: event.target.value })}
        />
      </label>
      <div className="flow-node-actions">
        {node.type === "agent" && chat && (
          <Button size="sm" onClick={chat}>
            Chat with Viber
          </Button>
        )}
        <Button size="sm" onClick={run} disabled={controlsDisabled || !!attempt}>
          Run node
        </Button>
        <Button
          size="sm"
          onClick={retry}
          disabled={
            controlsDisabled ||
            !attempt ||
            ![
              "failed",
              "cancelled",
              "interrupted",
              "rejected",
              ...(node.type === "approval" ? ["waiting"] : []),
            ].includes(attempt.status)
          }
        >
          {attempt?.status === "waiting" ? "Refresh approval" : "Retry node"}
        </Button>
        <Button size="sm" onClick={activity}>
          Activity
        </Button>
      </div>
      {attempt && (
        <p role="status">
          Attempt {attempt.ordinal} · {attempt.status}
          <br />
          <small>Verification: {attempt.verification}</small>
        </p>
      )}
      {attempt?.status === "waiting" && (
        <div className="flow-node-actions">
          <Button disabled={controlsDisabled} onClick={() => approve("accepted")}>
            Accept inputs
          </Button>
          <Button disabled={controlsDisabled} onClick={() => approve("rejected")}>
            Reject
          </Button>
        </div>
      )}
      {activityPreview && (
        <div className="flow-node-activity" aria-label="Current node activity">
          {activityPreview}
        </div>
      )}
      {node.type === "agent" && (
        <>
          <label>
            Profile
            <select
              value={node.profile_id}
              onChange={(event) =>
                update({ ...node, profile_id: event.target.value, overrides: {} })
              }
            >
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {profile && (
            <Button size="sm" variant="ghost" onClick={() => editProfile(profile)}>
              Edit reusable profile
            </Button>
          )}
          {execution && (
            <>
              <div className="viber-field-pair">
                <label>
                  Provider
                  <select
                    value={execution.provider}
                    onChange={(event) =>
                      override({ provider: event.target.value as typeof execution.provider })
                    }
                  >
                    <option value="codex">Codex</option>
                    <option value="antigravity">Antigravity</option>
                  </select>
                </label>
                <label>
                  Model
                  <input
                    value={execution.model}
                    placeholder="CLI default"
                    maxLength={200}
                    onChange={(event) => override({ model: event.target.value })}
                  />
                </label>
              </div>
              <div className="viber-field-pair">
                <label>
                  Effort
                  <input
                    value={execution.effort}
                    onChange={(event) => override({ effort: event.target.value })}
                  />
                </label>
                <label>
                  Timeout (seconds)
                  <input
                    type="number"
                    min={10}
                    max={86400}
                    value={execution.timeout_secs}
                    onChange={(event) => override({ timeout_secs: Number(event.target.value) })}
                  />
                </label>
              </div>
              <label>
                Workspace access
                <select
                  value={execution.access}
                  onChange={(event) =>
                    override({ access: event.target.value as typeof execution.access })
                  }
                >
                  {profile?.supported_access.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Output contract
                <select
                  value={execution.output}
                  onChange={(event) =>
                    override({ output: event.target.value as typeof execution.output })
                  }
                >
                  {[
                    "conversation",
                    "summary",
                    "plan",
                    "refinement",
                    "implementation",
                    "review",
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </>
          )}
        </>
      )}
      {node.type !== "command" ? (
        <label>
          Node instructions
          <textarea
            rows={5}
            value={node.instructions}
            maxLength={32000}
            onChange={(event) => update({ ...node, instructions: event.target.value })}
          />
        </label>
      ) : (
        <>
          <label>
            Command arguments (JSON array)
            <textarea
              key={node.id}
              rows={4}
              defaultValue={JSON.stringify(node.argv, null, 2)}
              onBlur={(event) => {
                try {
                  const argv: unknown = JSON.parse(event.target.value);
                  if (Array.isArray(argv) && argv.every((value) => typeof value === "string")) {
                    event.target.setCustomValidity("");
                    update({ ...node, argv });
                  } else event.target.setCustomValidity("Use a JSON array of strings.");
                } catch {
                  event.target.setCustomValidity("Use a valid JSON array of strings.");
                }

                event.target.reportValidity();
              }}
            />
          </label>
          <label>
            Command access
            <select
              value={node.access}
              onChange={(event) =>
                update({ ...node, access: event.target.value as typeof node.access })
              }
            >
              <option>read-only</option>
              <option>workspace-write</option>
            </select>
          </label>
          <label>
            Timeout (seconds)
            <input
              type="number"
              min={10}
              max={86400}
              value={node.timeout_secs}
              onChange={(event) => update({ ...node, timeout_secs: Number(event.target.value) })}
            />
          </label>
        </>
      )}
      <fieldset>
        <legend>Selected inputs</legend>
        <small>Connections schedule work. Select what this node receives.</small>
        {binding({ kind: "task-goal" }, "Task goal")}
        {binding({ kind: "task-brief" }, "Scoped brief and saved notes")}
        {binding({ kind: "repository" }, "Repository context")}
        {binding({ kind: "issue" }, "Issue context")}
        {contextChoices.map((choice) => binding(choice.binding, choice.title))}
        {node.inputs
          .filter(
            (input) =>
              ["artifact", "message", "command-evidence"].includes(input.kind) &&
              !contextChoices.some(
                (choice) => JSON.stringify(choice.binding) === JSON.stringify(input),
              ),
          )
          .map((input) =>
            binding(input, `Unavailable selected ${input.kind} · ${JSON.stringify(input)}`),
          )}
        {graph.nodes
          .filter((item) => ancestors.has(item.id))
          .map((item) => (
            <div key={item.id}>
              {binding({ kind: "output", node_id: item.id }, `${item.name} · output`)}
              {binding(
                { kind: "verification", node_id: item.id },
                `${item.name} · observed checks`,
              )}
            </div>
          ))}
      </fieldset>
      {node.type === "agent" && (
        <fieldset>
          <legend>Completion</legend>
          <label className="viber-checkbox">
            <input
              type="checkbox"
              checked={node.completion.verification === "require-passing"}
              onChange={(event) =>
                update({
                  ...node,
                  completion: {
                    ...node.completion,
                    verification: event.target.checked ? "require-passing" : "record-only",
                  },
                })
              }
            />
            Require observed passing checks
          </label>
          <label className="viber-checkbox">
            <input
              type="checkbox"
              checked={node.completion.review === "require-approved"}
              onChange={(event) =>
                update({
                  ...node,
                  completion: {
                    ...node.completion,
                    review: event.target.checked ? "require-approved" : "none",
                  },
                })
              }
            />
            Require independent approved review
          </label>
        </fieldset>
      )}
      <div className="flow-node-actions">
        <Button size="sm" onClick={duplicate}>
          Duplicate
        </Button>
        <Button size="sm" onClick={remove}>
          Delete node
        </Button>
      </div>
      {attempt?.error && (
        <p className="error" role="alert">
          {attempt.error}
        </p>
      )}
      {attempt && (
        <details>
          <summary>Captured settings, inputs and output</summary>
          <pre>
            {JSON.stringify(
              {
                configuration: attempt.configuration,
                inputs: attempt.inputs,
                output: attempt.output,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </aside>
  );
};
