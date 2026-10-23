// Bounded lexical coloring, rendered as React text. This is not a parser or HTML renderer.
export const highlightCode = (text: string, path: string) => {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const markup = ["html", "htm", "xml", "svg", "vue", "svelte"].includes(
    extension || "",
  );
  const style = ["css", "scss", "less"].includes(extension || "");
  const python = ["py", "sh", "bash", "yaml", "yml", "toml"].includes(
    extension || "",
  );
  const script = [
    "js",
    "jsx",
    "ts",
    "tsx",
    "json",
    "java",
    "c",
    "cpp",
    "h",
    "rs",
    "go",
    "swift",
    "kt",
  ].includes(extension || "");
  const tokens: { kind: string; text: string }[] = [];
  if ((!markup && !style && !python && !script) || text.length > 4000)
    return [{ kind: "text", text }];
  const comments = markup
    ? "<!--.*?(?:-->|$)"
    : python
      ? "#.*$"
      : "//.*$|/\\*.*?(?:\\*/|$)";
  const pattern = new RegExp(
    `${comments}|"(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\x60(?:\\\\.|[^\x60\\\\])*\x60?|\\b(?:const|let|var|function|return|if|else|for|while|async|await|import|export|from|class|extends|interface|type|new|throw|try|catch|true|false|null|undefined|def|self|None|True|False|in|with|as|print|public|private|static|void|int|package|use|fn|pub|match|struct|enum)\\b|\\b\\d+(?:\\.\\d+)?\\b${markup ? "|</?[\\w:-]+|/?>" : style ? "|[.#]?[\\w-]+(?=\\s*[:{])" : ""}`,
    "g",
  );
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (tokens.length >= 500) break;
    if (match.index > offset)
      tokens.push({ kind: "text", text: text.slice(offset, match.index) });
    const value = match[0];
    const kind =
      (markup && value.startsWith("<!--")) ||
      (python && value.startsWith("#")) ||
      (!markup && !python && /^(?:\/\/|\/\*)/.test(value))
        ? "comment"
        : /^["'`]/.test(value)
          ? "string"
          : /^\d/.test(value)
            ? "number"
            : markup && /[<>]/.test(value)
              ? "tag"
              : style
                ? "property"
                : "keyword";
    tokens.push({ kind, text: value });
    offset = match.index + value.length;
  }
  if (offset < text.length)
    tokens.push({ kind: "text", text: text.slice(offset) });
  return tokens;
};
