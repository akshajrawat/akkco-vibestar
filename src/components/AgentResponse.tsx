export const AgentResponse = ({ text }: { text: string }) => {
  let summary: string | undefined;
  try {
    const result: unknown = JSON.parse(text);
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const fields = result as Record<string, unknown>;
      const value = fields.summary ?? fields.goal;
      if (typeof value === "string") summary = value;
    }
  } catch {
    // Streaming prose remains visible without requiring a structured result.
  }
  return summary ? (
    <div className="agent-response">
      <p>{summary}</p>
      <details>
        <summary>View structured result</summary>
        <pre>{text}</pre>
      </details>
    </div>
  ) : (
    <pre>{text}</pre>
  );
};
