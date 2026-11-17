const summaryFields = ["summary", "goal", "understanding"];

/** Extract only complete JSON string characters; an unfinished escape waits for the next delta. */
export const streamingSummary = (text: string): string | null => {
  if (!text.trimStart().startsWith("{")) return null;
  const match = /"(?:summary|goal|understanding)"\s*:\s*"/.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  let value = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"') break;
    if (char !== "\\") {
      value += char;
      continue;
    }

    const escape = text[i + 1];
    if (!escape) break;
    const length = escape === "u" ? 6 : 2;
    const fragment = text.slice(i, i + length);
    if (fragment.length < length) break;
    try {
      value += JSON.parse(`"${fragment}"`) as string;
    } catch {
      break;
    }

    i += length - 1;
  }

  return value;
};

export const responseSummary = (text: string): string => {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const fields = value as Record<string, unknown>;
      const key = summaryFields.find((key) => typeof fields[key] === "string");
      if (key) return String(fields[key]);
    }
  } catch {
    // A partially streamed summary is still an answer, not a schema envelope.
  }

  return streamingSummary(text) ?? text;
};
