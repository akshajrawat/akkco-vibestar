import { useMemo } from "react";
import { FileSearch, FilePenLine, TerminalSquare, FlaskConical, Brain, Copy } from "lucide-react";
import type { AgentEvent, Run, Message } from "../../lib/types";
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
}: {
  events: AgentEvent[];
  runs: Run[];
  messages?: Message[];
}) => {
  const entries = useMemo(() => agentEntries(events), [events]);

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
    if (event.kind === "message") {
      return (
        <article className="message-event px-0 py-1" key={row.key}>
          <AgentResponse
            structured
            inline={!!finalText}
            text={finalText || String(data.text || "")}
          />
        </article>
      );
    }

    if (event.stream === "stderr") {
      return (
        <article className="provider-diagnostic" key={row.key}>
          <strong>Provider stderr</strong>
          <pre>{String(data.stderr || data.text || "")}</pre>
        </article>
      );
    }

    if (typeof data.unparsed === "string") {
      return (
        <article className="provider-diagnostic" key={row.key}>
          <strong>Provider stdout</strong>
          <pre>{data.unparsed}</pre>
        </article>
      );
    }

    if (["reasoning", "analysis"].includes(String(data.tool))) {
      const text = String(data.text || "").trim();
      if (!text) {
        return null;
      }

      return (
        <details className="reasoning-event" key={row.key}>
          <summary>
            <Brain size={16} className="shrink-0" />
            <span className="min-w-0 truncate">{text.split("\n")[0].replaceAll("**", "")}</span>
          </summary>
          <AgentResponse text={text} />
        </details>
      );
    }

    if (event.kind === "analysis.status" && typeof data.text === "string" && !data.tool) {
      const message =
        data.message ||
        data.text ||
        (data.error && typeof data.error === "object" && "message" in data.error
          ? data.error.message
          : data.error);

      return (
        <article key={row.key} className="provider-diagnostic" role="status">
          <AgentResponse
            text={typeof message === "string" ? message : JSON.stringify(data, null, 2)}
          />
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
    const finished = state !== "running" && state !== "pending";

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
                  : state === "pending"
                    ? "Command pending"
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

    return (
      <article
        className={`tool-event relative m-0 ${failed ? "tool-failed" : ""}`}
        data-state={state}
        key={row.key}
      >
        <details>
          <summary>
            <span className="tool-icon inline-flex items-center justify-center shrink-0">
              <Icon size={16} />
            </span>
            <span>{label}</span>
            <code>{paths.length ? paths.join(", ") : preview}</code>
          </summary>
          <div className="tool-details m-[3px_0_7px_18px] border-l border-l-border-default px-[11px] py-[7px] max-h-[300px] overflow-auto text-[12px]">
            {data.command != null && <code>{String(data.command)}</code>}
            {paths.map((path) => (
              <div key={path}>
                <code>{path}</code>
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
  };

  const blocks: { time: string; key: string; content: React.ReactNode }[] = [];
  for (const message of messages.filter(
    (message) => message.role !== "assistant" || !answeredRuns.has(message.run_id || ""),
  )) {
    const failed = message.role === "user" && message.status === "failed";
    const linkedRun = message.run_id ? runById.get(message.run_id) : undefined;

    blocks.push({
      time: message.created_at,
      key: message.id,
      content: (
        <>
          {failed && (
            <small className="mb-1 block pr-3 text-right font-medium text-accent-red">Failed</small>
          )}
          <article
            className={
              message.role === "assistant"
                ? "saved-assistant-message"
                : `user-message relative mb-3 ml-auto px-[13px] py-[9px] ${failed ? "mt-0" : "mt-5"}`
            }
            data-message-id={message.id}
          >
            {message.status === "cancelled" && <small className="subtle">cancelled</small>}
            {message.role === "assistant" && message.status === "failed" && (
              <small className="subtle">failed</small>
            )}

            {message.role === "assistant" ? (
              <AgentResponse text={message.content} />
            ) : (
              <UserMessageBody>
                <p>{message.content.split("\n\nLinked PR review context (untrusted):")[0]}</p>
              </UserMessageBody>
            )}
            <div className="message-actions flex gap-[3px] opacity-0 focus-within:opacity-100 [transition:opacity_200ms_ease]">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Copy message"
                title="Copy message"
                onClick={() => void navigator.clipboard.writeText(message.content).catch(() => {})}
              >
                <Copy size={16} />
              </Button>
            </div>
          </article>
          {message.error && !linkedRun?.error && (
            <div className="mt-7">
              <RunError error={message.error} />
            </div>
          )}
        </>
      ),
    });
  }

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
    const local = run.id ? (entriesByRun.get(run.id) ?? []) : entries;

    if (!run.id && !local.length) {
      continue;
    }

    const finalSummary = run.output ? responseSummary(run.output).trim() : undefined;
    const latest = local.at(-1);

    const finalMessage = run.output
      ? [...local].reverse().find((row) => {
          if (row.event.kind !== "message" || row.data.phase === "commentary") {
            return false;
          }

          const text = String(row.data.text || "");
          return (
            responseSummary(text).trim() === finalSummary ||
            (text.trimStart().startsWith("{") && /"(?:summary|goal|understanding)"/.test(text))
          );
        })
      : latest?.event.kind === "message" && latest.data.phase !== "commentary"
        ? latest
        : undefined;

    const activity = local.filter((row) => {
      if (row === finalMessage || ["run.failed", "run.cancelled"].includes(row.event.kind)) {
        return false;
      }

      if (finalMessage && row.event.kind === "message") {
        return responseSummary(String(row.data.text || "")).trim() !== finalSummary;
      }

      return true;
    });

    blocks.push({
      time: run.started_at,
      key: run.id || "ungrouped",
      content: (
        <section className="agent-turn m-[12px_0_24px]">
          {run.id ? (
            <WorkLog run={run} hasActivity={activity.length > 0}>
              {activity.map((row) => renderTool(row))}
            </WorkLog>
          ) : (
            activity.map((row) => renderTool(row))
          )}
          {finalMessage && renderTool(finalMessage, run.output || undefined)}
          {run.output && !finalMessage && <AgentResponse text={run.output} inline />}
          {run.error && <RunError error={run.error} run={run} />}
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
