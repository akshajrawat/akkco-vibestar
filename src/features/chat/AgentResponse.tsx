import { memo } from "react";

import { MarkdownContent } from "../../components/ui/MarkdownContent";
import { VerificationCheckSchema } from "../../../backend/execution/verification/verification";
import { streamingSummary } from "./output/response";

const resultValue = (value: unknown): React.ReactNode => {
  const verification = VerificationCheckSchema.safeParse(value);
  if (verification.success) {
    const check = verification.data;
    return (
      <div className="agent-verification-item">
        <strong
          className={
            check.outcome === "passed"
              ? "success"
              : check.outcome === "failed"
                ? "failure"
                : "warning"
          }
        >
          {check.name} · {check.outcome.replaceAll("_", " ")}
        </strong>

        <small>
          Provider reported · {check.kind} · {check.required ? "required" : "optional"}
        </small>
        <p>{check.detail}</p>
        {check.prerequisite && <p>Prerequisite: {check.prerequisite}</p>}
        {check.command && (
          <details>
            <summary>Reported command</summary>
            <code>{check.command}</code>
          </details>
        )}
      </div>
    );
  }

  if (typeof value === "string") return <MarkdownContent text={value} />;
  if (Array.isArray(value))
    return value.length ? (
      <ul>
        {value.map((entry, i) => (
          <li key={i}>{resultValue(entry)}</li>
        ))}
      </ul>
    ) : (
      <p className="subtle">None reported</p>
    );
  if (value && typeof value === "object")
    return (
      <dl className="result-fields">
        {Object.entries(value).map(([key, entry]) => (
          <div key={key}>
            <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
            <dd>{resultValue(entry)}</dd>
          </div>
        ))}
      </dl>
    );
  return <p>{value === null ? "Not reported" : String(value)}</p>;
};

export const AgentResponse = memo(
  ({
    text,
    expanded = false,
    structured = false,
    inline = false,
  }: {
    text: string;
    expanded?: boolean;
    structured?: boolean;
    inline?: boolean;
  }) => {
    let fields: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value))
        fields = value as Record<string, unknown>;
    } catch {
      /* Prose and incomplete streams remain readable. */
    }

    if (fields) {
      const summaryKey = ["summary", "goal", "understanding"].find(
        (key) => typeof fields![key] === "string",
      );

      const summary = summaryKey ? String(fields[summaryKey]) : "Provider result";

      const entries = Object.entries(fields).filter(
        ([key, value]) =>
          key !== summaryKey &&
          (!inline || (Array.isArray(value) ? value.length > 0 : value !== "" && value != null)),
      );

      const sections = entries.map(([key, value]) => (
        <section key={key}>
          <h3>{key.replace(/([A-Z])/g, " $1")}</h3>
          {resultValue(value)}
        </section>
      ));

      return (
        <div className="agent-response markdown">
          <MarkdownContent text={summary} />
          {entries.length > 0 &&
            (inline ? (
              <div className="response-fields">{sections}</div>
            ) : (
              <details open={expanded || undefined}>
                <summary>View result details</summary>
                {sections}
              </details>
            ))}
        </div>
      );
    }

    const partial = streamingSummary(text);
    if (partial !== null)
      return (
        <div className="agent-response markdown" aria-busy="true">
          <MarkdownContent text={partial} />
        </div>
      );
    if (
      text.trimStart().startsWith("{") &&
      (structured || /"(?:summary|goal|understanding)"\s*:/.test(text))
    )
      return (
        <span className="subtle" role="status">
          Receiving response…
        </span>
      );
    return (
      <div className="agent-response markdown">
        <MarkdownContent text={text} />
      </div>
    );
  },
);
