/** Converts paste/drop text to label names, accepting URLs only for the selected repository's GitHub issue search. */
export const parseLabelInput = (text: string, repository: string) => {
  if (text.length > 16000) throw new Error("Label input is too long.");

  const target = repository
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();

  const labels: string[] = [];

  const add = (value: string) => {
    const label = value.trim();
    if (!label || label.length > 100 || /[\x00-\x1f\x7f<>]/.test(label))
      throw new Error("Use a label name of 1–100 characters.");
    if (!labels.some((item) => item.toLowerCase() === label.toLowerCase())) labels.push(label);
  };

  const input = text.trim().replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, "$2");
  for (const part of input
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (
      /^[a-z][a-z\d+.-]*:\/\//i.test(part) ||
      /^(?:https?|javascript|data|file|ftp):/i.test(part)
    ) {
      let url: URL;
      try {
        decodeURI(part);
        url = new URL(part);
      } catch {
        throw new Error("This label URL is malformed.");
      }

      const path = url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/issues\/?$/);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.username ||
        url.password ||
        url.port ||
        !path
      )
        throw new Error("Paste a GitHub issues-search label link or a plain label name.");
      if (!target || `${path[1]}/${path[2]}`.toLowerCase() !== target)
        throw new Error(
          "This label link belongs to another repository. Choose a matching repository first.",
        );
      const query = url.searchParams.get("q") || "";
      const matches = [...query.matchAll(/(?:^|\s)label:(?:"([^"\n]+)"|([^\s"]+))/gi)];
      if (!matches.length) throw new Error("This GitHub link does not contain a label filter.");
      for (const match of matches) add(match[1] || match[2]);
    } else {
      if (/[[\]()]|:\/\//.test(part) || /^(?:www\.|github\.com\/)/i.test(part))
        throw new Error("Use a plain label name or a supported GitHub label link.");
      add(part);
    }
  }

  if (labels.length > 30) throw new Error("Choose at most 30 excluded labels.");
  return labels;
};
