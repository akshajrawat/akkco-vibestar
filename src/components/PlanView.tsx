import type { Artifact, Run, AgentEvent } from "../lib/types";
import { StreamedPlan } from "../../backend/execution/streamed-plan";
import { eventData } from "../lib/api";
import { RunPrompt } from "./RunPrompt";
import { Button } from "./ui/button";

export const PlanView = ({
  artifacts,
  runs = [],
  events = [],
  acceptDraft,
  busy = false,
  compact = false,
  selectedStage = 1,
  selectStage,
}: {
  artifacts: Artifact[];
  runs?: Run[];
  events?: AgentEvent[];
  acceptDraft?: (run: Run) => void;
  busy?: boolean;
  compact?: boolean;
  selectedStage?: 1 | 2;
  selectStage?: (stage: 1 | 2) => void;
}) => (
  <div className="plan-comparison">
    {compact && (
      <div
        className="plan-version-picker"
        role="group"
        aria-label="Plan version"
      >
        {([1, 2] as const).map((stage) => (
          <Button
            key={stage}
            size="sm"
            variant={selectedStage === stage ? "secondary" : "ghost"}
            aria-pressed={selectedStage === stage}
            onClick={() => selectStage?.(stage)}
          >
            {stage === 1 ? "Antigravity original" : "Codex refined"}
          </Button>
        ))}
      </div>
    )}
    {(compact ? [selectedStage] : [1, 2]).map((stage) => {
      const saved = [...artifacts]
        .reverse()
        .find((a) => a.stage === stage && a.kind === "plan");
      const run = [...runs]
        .reverse()
        .find((r) => r.stage === stage && r.purpose !== "Code Review Ask AI");
      const stored = artifacts.find((a) => a.kind === `draft:${run?.id}`);
      let draft: unknown = stored ? JSON.parse(stored.content).plan : null;
      if (!draft && run) {
        const stream = new StreamedPlan(stage);
        for (const event of events.filter(
          (e) => e.run_id === run.id && e.kind === "message",
        ))
          draft = stream.observe(eventData(event.data)) || draft;
      }
      const result = saved ? JSON.parse(saved.content) : draft;
      return (
        <section key={stage}>
          <div className="panel-heading">
            <strong>
              {stage === 1 ? "Antigravity original plan" : "Codex refined plan"}
            </strong>
            <small>
              {saved
                ? "Saved plan"
                : draft
                  ? "Streamed draft"
                  : run?.status === "running"
                    ? "Planning…"
                    : "Awaiting stage"}
            </small>
          </div>
          {run && <RunPrompt run={run} />}
          {!!draft && !saved && (
            <div className="plan-draft-notice">
              <p>
                This draft was emitted by the provider. The CLI has not
                confirmed successful completion.
              </p>
              {acceptDraft &&
                run &&
                runs.at(-1)?.id === run.id &&
                run.status !== "completed" && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => acceptDraft(run)}
                  >
                    {run.status === "running"
                      ? "Stop run & use this draft…"
                      : "Use this draft…"}
                  </Button>
                )}
            </div>
          )}
          {result ? (
            Object.entries(result as Record<string, unknown>).map(
              ([key, value]) => (
                <div className="plan-section" key={key}>
                  <h3>{key.replace(/([A-Z])/g, " $1")}</h3>
                  {Array.isArray(value) ? (
                    value.length ? (
                      <ol>
                        {value.map((v, i) => (
                          <li key={i}>{String(v)}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="subtle">None</p>
                    )
                  ) : (
                    <p>{String(value)}</p>
                  )}
                </div>
              ),
            )
          ) : (
            <p className="empty-row">
              {run?.status === "running"
                ? "Planning is running. A structured draft will appear here as soon as it is emitted."
                : run
                  ? `This run ${run.status} before a valid plan was saved. View its prompt and Agent Output for details.`
                  : "This stage starts after you approve the preceding stage."}
            </p>
          )}
        </section>
      );
    })}
  </div>
);
