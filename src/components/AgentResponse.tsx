import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
const resultValue = (value: unknown): React.ReactNode => {
  if (typeof value === "string")
    return <Markdown remarkPlugins={[remarkGfm]}>{value}</Markdown>;
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
export const AgentResponse = ({
  text,
  expanded = false,
}: {
  text: string;
  expanded?: boolean;
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
    return (
      <div className="agent-response markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown>
        <details open={expanded || undefined}>
          <summary>View result details</summary>
          {Object.entries(fields)
            .filter(([key]) => key !== summaryKey)
            .map(([key, value]) => (
              <section key={key}>
                <h3>{key.replace(/([A-Z])/g, " $1")}</h3>
                {resultValue(value)}
              </section>
            ))}
        </details>
      </div>
    );
  }
  // Never display provider envelopes or streaming schema fragments as chat.
  if (text.trim().startsWith("{"))
    return (
      <span className="subtle">
        Receiving structured output · inspect Raw for emitted fields
      </span>
    );
  return (
    <div className="agent-response markdown">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
};
