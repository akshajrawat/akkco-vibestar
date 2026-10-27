import { RunPrompt } from "./RunPrompt";
import { useMemo } from "react";
import {
  FileSearch,
  FilePenLine,
  TerminalSquare,
  FlaskConical,
  Brain,
  Check,
  LoaderCircle,
  CircleMinus,
  CircleAlert,
} from "lucide-react";
import type { AgentEvent, Run, Message, DiffFile } from "../../lib/types";
import { duration } from "../../lib/format";
import { eventData } from "./output/events";
import { agentEntries, toolState } from "./output/activity";
import { AgentResponse } from "./AgentResponse";
import { RunError } from "./RunError";
import { Button } from "../../components/ui/button";
import { ProviderIcon } from "../../components/ui/ProviderIcon";

export const AgentTimeline = ({
  events,
  runs,
  messages = [],
  files = [],
  openDiff,
  retryMessage,
  editMessage,
  search = "",
  filter = "all",
  expandResults = true,
}: {
  events: AgentEvent[];
  runs: Run[];
  messages?: Message[];
  files?: DiffFile[];
  openDiff?: (path: string) => void;
  retryMessage?: (message: Message) => void;
  editMessage?: (message: Message) => void;
  search?: string;
  filter?: string;
  expandResults?: boolean;
}) => {
  const entries = useMemo(() => agentEntries(events, search), [events, search]);

  const renderTool = (row: (typeof entries)[number]) => {
    const { event, data } = row;
    const run = runs.find((r) => r.id === event.run_id);
    if (event.kind === "message")
      return (
        <article className="message-event" key={row.key}>
          <AgentResponse text={String(data.text || "")} />
        </article>
      );
    if (event.stream === "stderr")
      return (
        <article className="provider-diagnostic" key={row.key}>
          <strong>Provider stderr</strong>
          <pre>{String(data.stderr || data.text || "")}</pre>
        </article>
      );
    if (typeof data.unparsed === "string")
      return (
        <article className="provider-diagnostic" key={row.key}>
          <strong>Provider stdout</strong>
          <pre>{data.unparsed}</pre>
        </article>
      );
    if (
      ["run.failed", "run.cancelled"].includes(event.kind) ||
      (event.kind === "analysis.status" && typeof data.text === "string" && !data.tool)
    ) {
      const error = event.kind === "run.failed";

      const message =
        data.message ||
        data.text ||
        (data.error && typeof data.error === "object" && "message" in data.error
          ? data.error.message
          : data.error);

      return (
        <article
          key={row.key}
          className={`provider-diagnostic ${error ? "failure" : ""}`}
          role="status"
        >
          <strong>
            {error
              ? "Provider error"
              : event.kind === "run.cancelled"
                ? "Run cancelled"
                : "Provider status"}
          </strong>

          <AgentResponse
            text={typeof message === "string" ? message : JSON.stringify(data, null, 2)}
          />

          <details>
            <summary>Emitted event</summary>
            <pre>{event.raw || JSON.stringify(data, null, 2)}</pre>
          </details>
        </article>
      );
    }

    const search =
      /search|grep|find_by_name/.test(String(data.tool)) ||
      /\b(rg|grep|find)\b/.test(String(data.command));

    const edited = event.kind === "file.changed";
    const command = event.kind.startsWith("command");
    const state = toolState(event, data, run);
    const failed = state === "failed";
    const interrupted = state === "interrupted";
    const finished = state !== "running";

    const observedDuration =
      command && row.initial.kind === "command.started" && event.kind === "command.finished"
        ? duration(row.initial.timestamp, event.timestamp)
        : "";

    const skipped = state === "skipped" || state === "blocked";

    const Icon = edited
      ? FilePenLine
      : search || event.kind === "file.read"
        ? FileSearch
        : command
          ? TerminalSquare
          : event.kind === "test.result"
            ? FlaskConical
            : Brain;

    const label = search
      ? "Search"
      : edited
        ? state === "running"
          ? "Editing"
          : interrupted
            ? "Edit interrupted"
            : failed
              ? "Edit failed"
              : "Edited"
        : event.kind === "file.read"
          ? state === "running"
            ? "Reading file"
            : interrupted
              ? "Read interrupted"
              : failed
                ? "Read failed"
                : "Read file"
          : command
            ? state === "blocked"
              ? "Command blocked"
              : failed
                ? "Command failed"
                : interrupted
                  ? "Command interrupted"
                  : finished
                    ? "Ran"
                    : "Running command"
            : event.kind === "test.result"
              ? `Test ${data.status || "result"}`
              : data.tool
                ? String(data.tool)
                : "Provider event";

    const paths = (
      Array.isArray(data.files) ? data.files : edited && data.path ? [data.path] : []
    ).map(String);

    const preview = String(data.command || data.path || data.query || data.text || "");

    const sandboxDropped = String(data.stderr || data.stdout || "").includes(
      "connecting to sandbox server",
    );

    return (
      <article
        className={`tool-event ${failed ? "tool-failed" : interrupted ? "tool-interrupted" : skipped ? "tool-skipped" : ""}`}
        data-state={state}
        key={row.key}
      >
        <details>
          <summary>
            <Icon size={13} />
            <span>
              {label}
              {command ? " ·" : ""}
            </span>

            <code>
              {paths.length ? `${paths.length} file${paths.length === 1 ? "" : "s"}` : preview}
            </code>
            <small className="tool-state">{state}</small>
            {skipped || interrupted ? (
              <CircleMinus size={12} className="warning" />
            ) : failed ? (
              <CircleAlert size={12} className="failure" />
            ) : finished && !failed ? (
              command && data.exit_code !== 0 ? (
                <CircleMinus size={12} className="subtle" />
              ) : (
                <Check size={12} className="success" />
              )
            ) : !finished ? (
              <LoaderCircle size={12} className="running spinning" />
            ) : null}

            {typeof data.duration_ms === "number" && (
              <small>{Math.round(data.duration_ms / 1000)}s</small>
            )}

            {typeof data.duration_ms !== "number" && observedDuration && (
              <small title="Time between reported tool start and finish">
                Observed {observedDuration}
              </small>
            )}
          </summary>

          <div className="tool-details">
            <dl className="tool-facts">
              <dt>Tool</dt>
              <dd>
                <code>{String(data.tool || (command ? "command_execution" : event.kind))}</code>
              </dd>

              {data.arguments != null && (
                <>
                  <dt>Arguments</dt>
                  <dd>
                    <pre>
                      {typeof data.arguments === "string"
                        ? data.arguments
                        : JSON.stringify(data.arguments, null, 2)}
                    </pre>
                  </dd>
                </>
              )}

              {data.command != null && (
                <>
                  <dt>Command</dt>
                  <dd>
                    <code>{String(data.command)}</code>
                  </dd>
                </>
              )}

              {data.path != null && (
                <>
                  <dt>Path</dt>
                  <dd>
                    <code>{String(data.path)}</code>
                  </dd>
                </>
              )}
            </dl>

            {sandboxDropped && (
              <p className="warning">
                Antigravity's command sandbox connection dropped. This command did not complete;
                file reads use a separate tool. A later successful command does not change this
                failed attempt.
              </p>
            )}

            {paths.map((path) => {
              const file = files.find((f) => path === f.path || path.endsWith(`/${f.path}`));
              const Entry = openDiff ? "button" : "div";
              return (
                <Entry
                  className="edited-file"
                  key={path}
                  onClick={openDiff ? () => openDiff(file?.path || path) : undefined}
                >
                  <FilePenLine size={12} />
                  <code>{file?.path || path}</code>
                  <span className="spacer" />
                  {file && (
                    <>
                      <span className="success">+{file.insertions}</span>
                      <span className="failure">−{file.deletions}</span>
                    </>
                  )}
                </Entry>
              );
            })}

            {
              <>
                {data.stdout || data.stderr ? (
                  <>
                    {typeof data.stdout === "string" && (
                      <section className="tool-stream">
                        <strong>
                          {data.output_source === "aggregate"
                            ? "Command output · provider aggregate"
                            : data.output_source === "provider"
                              ? "Provider tool output"
                              : "stdout"}
                        </strong>
                        <pre>{data.stdout}</pre>
                      </section>
                    )}

                    {typeof data.stderr === "string" && (
                      <section className="tool-stream">
                        <strong>stderr</strong>
                        <pre className="warning">{data.stderr}</pre>
                      </section>
                    )}
                  </>
                ) : (
                  <pre>{String(data.text || data.path || data.command || "")}</pre>
                )}
              </>
            }
            {typeof data.exit_code === "number" && <small>Exit {data.exit_code}</small>}
            {command && typeof data.exit_code !== "number" && (
              <small>Exit status not reported</small>
            )}

            {typeof data.duration_ms !== "number" && !observedDuration && (
              <small>Duration not reported</small>
            )}

            <details className="tool-technical">
              <summary>Technical details · emitted event</summary>
              <pre>
                {JSON.stringify(
                  row.initial.id !== event.id
                    ? {
                        initial: eventData(row.initial.raw || row.initial.data),
                        latest: eventData(event.raw || event.data),
                      }
                    : event.raw
                      ? eventData(event.raw)
                      : data,
                  null,
                  2,
                )}
              </pre>
            </details>

            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void navigator.clipboard.writeText(JSON.stringify(data, null, 2)).catch(() => {})
              }
            >
              Copy tool details
            </Button>
            {data.source === "provider-reported" && <small>Provider reported</small>}
          </div>
        </details>

        {edited && paths.length === 1 && openDiff && (
          <button className="inline-diff-link" onClick={() => openDiff?.(paths[0])}>
            Open in editor ↗
          </button>
        )}
      </article>
    );
  };

  const blocks: { time: string; key: string; content: React.ReactNode }[] = [];
  for (const message of messages.filter(
    (message) => message.role !== "assistant" || !runs.some((run) => run.id === message.run_id),
  ))
    blocks.push({
      time: message.created_at,
      key: message.id,
      content: (
        <article className="user-message">
          <small>
            {message.role === "assistant" ? "Agent" : "You"}
            {message.purpose === "chat" ? " · Read-only conversation" : ""}
          </small>

          {message.status?.startsWith("chat_") && message.status !== "chat_completed" && (
            <small className="subtle">
              {message.status.replace("chat_", "").replaceAll("_", " ")}
            </small>
          )}

          {message.status === "queued" && (
            <small className="running">Feedback queued · next safe stage boundary</small>
          )}

          {message.status === "draft" && (
            <small className="warning">Instruction saved for later · no agent started</small>
          )}
          <p>{message.content.split("\n\nLinked PR review context (untrusted):")[0]}</p>
          <div className="message-actions">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.clipboard.writeText(message.content).catch(() => {})}
            >
              Copy
            </Button>

            {retryMessage && message.status !== "review_question" && message.purpose !== "chat" && (
              <Button size="sm" variant="ghost" onClick={() => retryMessage(message)}>
                {message.status === "draft" ? "Send saved instruction" : "Retry"}
              </Button>
            )}

            {editMessage &&
              message.status !== "review_question" &&
              message.role !== "assistant" && (
                <Button size="sm" variant="ghost" onClick={() => editMessage(message)}>
                  Edit &amp; retry
                </Button>
              )}
          </div>
        </article>
      ),
    });

  const groupedRuns = runs.length
    ? runs
    : [
        {
          id: "",
          provider: "Agent",
          started_at: "",
          status: "",
          stage: 0,
        } as Run,
      ];

  for (const run of groupedRuns) {
    const local = entries.filter(
      (e) =>
        (!run.id || e.event.run_id === run.id) &&
        (!search ||
          e.matches ||
          JSON.stringify(e.data).toLowerCase().includes(search.toLowerCase())) &&
        (filter === "all" ||
          (filter === "messages"
            ? e.event.kind === "message"
            : filter === "commands"
              ? e.event.kind.startsWith("command.") && e.event.stream !== "stderr"
              : filter === "files"
                ? e.event.kind.startsWith("file.")
                : filter === "errors"
                  ? e.event.stream === "stderr" ||
                    ["run.failed", "run.cancelled"].includes(e.event.kind) ||
                    ["failed", "interrupted", "blocked"].includes(toolState(e.event, e.data, run))
                  : e.event.kind === "test.result")),
    );

    blocks.push({
      time: run.started_at,
      key: run.id || "ungrouped",
      content: (
        <section className="agent-turn">
          {run.id && (
            <div className="agent-turn-heading">
              <span className={`agent-avatar ${run.provider}`}>
                <ProviderIcon provider={run.provider} model={run.model} size={14} />
              </span>
              <strong>{run.provider === "antigravity" ? "Antigravity" : "Codex"}</strong>
              <span className="subtle">
                {run.purpose === "Read-only conversation"
                  ? "Conversation · read-only"
                  : run.purpose === "Code Review Ask AI"
                    ? "Code review · read-only"
                    : run.purpose === "scheduled"
                      ? "PR review"
                      : run.stage === 1
                        ? "Planning"
                        : run.stage === 2
                          ? "Reviewing plan"
                          : run.stage === 5
                            ? "Reviewing changes & tests"
                            : "Implementing"}
              </span>

              <small>
                {run.model || "CLI default"} · {run.effort}
              </small>
            </div>
          )}
          {run.id && <RunPrompt run={run} />}
          {local
            .filter(
              (row) =>
                !(
                  row.event.kind === "message" &&
                  run.output &&
                  String(row.data.text).trim().startsWith("{")
                ),
            )
            .map(renderTool)}

          {run.output &&
            (filter === "all" || filter === "messages") &&
            (!search || run.output.toLowerCase().includes(search.toLowerCase())) && (
              <AgentResponse
                text={run.output}
                expanded={expandResults || [1, 2].includes(run.stage)}
              />
            )}
          {run.error && <RunError error={run.error} run={run} />}
          {run.id && (
            <div className="turn-outcome">
              {run.status === "running" ? (
                <>
                  <LoaderCircle size={12} className="spinning" />
                  Working…
                </>
              ) : (
                <>
                  {run.status === "completed" ? <Check size={12} /> : null}
                  {run.status === "completed" && run.purpose === "Read-only conversation"
                    ? "Answer completed"
                    : run.status === "completed"
                      ? run.stage === 1
                        ? "Plan completed"
                        : run.stage === 2
                          ? "Plan refined"
                          : run.stage === 5
                            ? "Final review completed"
                            : "Implementation completed"
                      : run.status}{" "}
                  · {duration(run.started_at, run.ended_at)}
                </>
              )}
            </div>
          )}
        </section>
      ),
    });
  }

  return (
    <>
      {blocks
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((b) => (
          <div key={b.key}>{b.content}</div>
        ))}
    </>
  );
};
