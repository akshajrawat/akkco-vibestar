import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
export const AgentResponse = ({ text }: { text: string }) => {
  let fields: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value))
      fields = value as Record<string, unknown>;
  } catch {
    /* Prose and incomplete streams remain readable. */
  }
  if (fields) {
    const summary = fields.summary ?? fields.goal ?? fields.understanding;
    if (typeof summary !== "string") return null;
    return (
      <div className="agent-response markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown>
        <details>
          <summary>View result details</summary>
          {Object.entries(fields)
            .filter(([key]) => !["summary", "goal"].includes(key))
            .map(([key, value]) => (
              <section key={key}>
                <h3>{key.replace(/([A-Z])/g, " $1")}</h3>
                {Array.isArray(value) ? (
                  <ul>
                    {value.map((v, i) => (
                      <li key={i}>{String(v)}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{String(value)}</p>
                )}
              </section>
            ))}
        </details>
      </div>
    );
  }
  // Never display provider envelopes or streaming schema fragments as chat.
  if (text.trim().startsWith("{"))
    return <span className="subtle">Preparing response…</span>;
  return (
    <div className="agent-response markdown">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
};
