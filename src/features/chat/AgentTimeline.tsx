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
  Copy,
  Pencil,
} from "lucide-react";
import type { AgentEvent, Run, Message, DiffFile } from "../../lib/types";
import { duration } from "../../lib/format";
import { eventData } from "./output/events";
import { agentEntries, toolState } from "./output/activity";
import { AgentResponse } from "./AgentResponse";
import { RunError } from "./RunError";
import { Button } from "../../components/ui/button";
import { responseSummary } from "./output/response";
import { WorkLog } from "./WorkLog";
import { UserMessageBody } from "./UserMessageBody";

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
  runSummary,
  compact = false,
  showPrompts = false,
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
  runSummary?: (run: Run) => React.ReactNode;
  compact?: boolean;
  showPrompts?: boolean;
}) => {
  const entries = useMemo(() => agentEntries(events, search), [events, search]);

  const runById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);

  const entriesByRun = useMemo(() => {
    const grouped = new Map<string, typeof entries>();
    for (const entry of entries) {
      const local = grouped.get(entry.event.run_id) || [];
      local.push(entry);
      grouped.set(entry.event.run_id, local);
    }

    return grouped;
  }, [entries]);

  const lastImplementation = [...runs]
    .reverse()
    .find((run) => run.stage === 3 && run.purpose !== "Read-only conversation");

  const answeredRuns = useMemo(
    () =>
      new Set(
        runs
          .filter(
            (run) =>
              run.output ||
              entriesByRun
                .get(run.id)
                ?.some(
                  (entry) =>
                    entry.event.kind === "message" &&
                    responseSummary(String(entry.data.text || "")).trim(),
                ),
          )
          .map((run) => run.id),
      ),
    [runs, entriesByRun],
  );

  const renderTool = (row: (typeof entries)[number], finalText?: string) => {
    const { event, data } = row;
    const run = runById.get(event.run_id);
    if (event.kind === "message")
      return (
        <article className="message-event" key={row.key}>
          <AgentResponse
            structured
            inline={compact && !!finalText}
            expanded={finalText ? expandResults : false}
            text={finalText || String(data.text || "")}
          />
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
    if (compact && ["reasoning", "analysis"].includes(String(data.tool))) {
      const text = String(data.text || "").trim();
      if (!text) return null;
      return (
        <details className="reasoning-event" key={row.key}>
          <summary>
            <Brain size={16} /> {text.split("\n")[0].replaceAll("**", "")}
          </summary>
          <AgentResponse text={text} />
        </details>
      );
    }

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
          {!compact && (
            <strong>
              {error
                ? "Provider error"
                : event.kind === "run.cancelled"
                  ? "Run cancelled"
                  : "Provider status"}
            </strong>
          )}

          <AgentResponse
            text={typeof message === "string" ? message : JSON.stringify(data, null, 2)}
          />

          {!compact && (
            <details>
              <summary>Emitted event</summary>
              <pre>{event.raw || JSON.stringify(data, null, 2)}</pre>
            </details>
          )}
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

    if (compact)
      return (
        <article
          className={`tool-event ${failed ? "tool-failed" : ""}`}
          data-state={state}
          key={row.key}
        >
          <details>
            <summary>
              <span className="tool-icon">
                <Icon size={16} />
              </span>
              <span>{label}</span>
              <code>{paths.length ? paths.join(", ") : preview}</code>
            </summary>
            <div className="tool-details">
              {data.command != null && <code>{String(data.command)}</code>}
              {paths.map((path) => (
                <div key={path}>
                  {openDiff ? (
                    <button className="edited-file" onClick={() => openDiff(path)}>
                      {path}
                    </button>
                  ) : (
                    <code>{path}</code>
                  )}
                </div>
              ))}
              {data.stdout != null && <pre>{String(data.stdout)}</pre>}
              {data.stderr != null && <pre>{String(data.stderr)}</pre>}
              {data.text != null && <AgentResponse text={String(data.text)} />}
              {typeof data.exit_code === "number" && <small>Exit {data.exit_code}</small>}
              {failed && <small className="failure">Failed</small>}
              {interrupted && <small className="warning">Interrupted</small>}
              {skipped && (
                <small className="warning">{state === "blocked" ? "Blocked" : "Skipped"}</small>
              )}
            </div>
          </details>
        </article>
      );

    return (
      <article
        className={`tool-event ${failed ? "tool-failed" : interrupted ? "tool-interrupted" : skipped ? "tool-skipped" : ""}`}
        data-state={state}
        key={row.key}
      >
        <details>
          <summary>
            <span className="tool-icon">
              <Icon size={14} />
            </span>
            <span>
              {label}
              {command ? " ·" : ""}
            </span>

            <code>
              {paths.length ? `${paths.length} file${paths.length === 1 ? "" : "s"}` : preview}
            </code>
            <small className="tool-state">
              {data.source === "provider-reported" ? "provider reported" : state}
            </small>
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
    (message) => message.role !== "assistant" || !answeredRuns.has(message.run_id || ""),
  ))
    blocks.push({
      time: message.created_at,
      key: message.id,
      content: (
        <article
          className={message.role === "assistant" ? "saved-assistant-message" : "user-message"}
          data-message-id={message.id}
        >
          {message.status?.startsWith("chat_") &&
            ["chat_failed", "chat_cancelled"].includes(message.status) && (
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
          {message.role === "assistant" ? (
            <AgentResponse text={message.content} />
          ) : (
            <UserMessageBody>
              <p>{message.content.split("\n\nLinked PR review context (untrusted):")[0]}</p>
            </UserMessageBody>
          )}
          <div className="message-actions">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Copy message"
              title="Copy message"
              onClick={() => void navigator.clipboard.writeText(message.content).catch(() => {})}
            >
              <Copy size={16} />
            </Button>

            {retryMessage && message.status !== "review_question" && message.purpose !== "chat" && (
              <Button size="sm" variant="ghost" onClick={() => retryMessage(message)}>
                {message.status === "draft" ? "Send saved instruction" : "Retry"}
              </Button>
            )}

            {editMessage &&
              message.status !== "review_question" &&
              message.role !== "assistant" && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Edit and retry message"
                  title="Edit and retry"
                  onClick={() => editMessage(message)}
                >
                  <Pencil size={16} />
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
    const local = (run.id ? entriesByRun.get(run.id) || [] : entries).filter(
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

    if (!run.id && !local.length) continue;

    const finalSummary = run.output ? responseSummary(run.output).trim() : undefined;

    const finalMessage = run.output
      ? [...local].reverse().find((row) => {
          if (row.event.kind !== "message" || row.data.phase === "commentary") return false;
          const text = String(row.data.text || "");
          return (
            responseSummary(text).trim() === finalSummary ||
            (text.trimStart().startsWith("{") && /"(?:summary|goal|understanding)"/.test(text))
          );
        })
      : compact &&
          local.at(-1)?.event.kind === "message" &&
          local.at(-1)?.data.phase !== "commentary"
        ? local.at(-1)
        : undefined;

    const visible = local.filter((row) => {
      if (row.event.kind === "run.failed" && run.error) return false;
      if (finalMessage && row !== finalMessage && row.event.kind === "message")
        return responseSummary(String(row.data.text || "")).trim() !== finalSummary;
      return true;
    });

    const activity = compact ? visible.filter((row) => row !== finalMessage) : visible;

    const workflowPrompt =
      showPrompts &&
      run.prompt &&
      [
        "Plan",
        "Plan refinement",
        "Implementation",
        "Review",
        "pipeline",
        "Antigravity Plan",
        "Codex Plan Refinement",
        "Codex Implementation",
      ].includes(run.purpose || "pipeline");

    let structuredPrompt = false;
    if (workflowPrompt && run.stage === 3) {
      try {
        structuredPrompt = !!JSON.parse(run.prompt);
      } catch {
        // Explicit instructions appended after a plan must remain visible too.
      }
    }

    blocks.push({
      time: run.started_at,
      key: run.id || "ungrouped",
      content: (
        <>
          {workflowPrompt && (
            <article className="user-message workflow-message" data-run-id={run.id}>
              <UserMessageBody>
                {structuredPrompt ? (
                  <AgentResponse inline text={run.prompt} />
                ) : (
                  <p>{run.prompt}</p>
                )}
              </UserMessageBody>
            </article>
          )}
          <section className="agent-turn">
            {!compact && run.id && run.purpose !== "Read-only conversation" && (
              <div className="agent-turn-heading">
                <span>
                  {run.purpose === "Code Review Ask AI"
                    ? "Code review"
                    : run.stage === 1
                      ? "Plan"
                      : run.stage === 2
                        ? "Plan refinement"
                        : run.stage === 5
                          ? "Implementation review"
                          : "Implementation"}
                </span>
              </div>
            )}
            {compact && run.id ? (
              <WorkLog run={run} hasActivity={activity.length > 0}>
                {activity.map((row) => renderTool(row))}
              </WorkLog>
            ) : (
              activity.map((row) =>
                renderTool(row, row === finalMessage ? run.output || undefined : undefined),
              )
            )}
            {compact && finalMessage && renderTool(finalMessage, run.output || undefined)}
            {run.output &&
              !finalMessage &&
              (filter === "all" || filter === "messages") &&
              (!search || run.output.toLowerCase().includes(search.toLowerCase())) && (
                <AgentResponse text={run.output} expanded={expandResults} inline={compact} />
              )}
            {run.id === lastImplementation?.id &&
              files.length > 0 &&
              (filter === "all" || filter === "files") && (
                <details className="chat-changes">
                  <summary>
                    Changed {files.length} {files.length === 1 ? "file" : "files"}
                  </summary>
                  {files.map((file) => (
                    <button
                      className="edited-file"
                      key={file.path}
                      onClick={() => openDiff?.(file.path)}
                    >
                      <FilePenLine size={13} />
                      <code>{file.path}</code>
                      <span className="spacer" />
                      <span className="success">+{file.insertions}</span>
                      <span className="failure">−{file.deletions}</span>
                    </button>
                  ))}
                </details>
              )}
            {run.error && <RunError error={run.error} run={run} />}
            {runSummary?.(run)}
            {!compact && run.id && (
              <div className="turn-outcome">
                {run.status === "running" ? (
                  <>
                    <LoaderCircle size={12} className="spinning" />
                    {run.provider === "antigravity" ? "Antigravity" : "Codex"} · Working…
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
        </>
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
