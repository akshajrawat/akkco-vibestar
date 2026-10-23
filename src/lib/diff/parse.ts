export interface DiffLine {
  kind: "context" | "add" | "delete" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export const sourceLines = (text: string) => {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.replace(/\r$/, ""));
};

export const parseUnifiedDiff = (patch: string) => {
  const hunks: DiffHunk[] = [];
  const unavailable = (reason: "oversized" | "unrecognized") => ({
    hunks: [] as DiffHunk[],
    reason,
  });
  if (patch.length > 750000) return unavailable("oversized");
  const lines = patch.split("\n");
  if (lines.length > 12000) return unavailable("oversized");
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let files = 0;
  const complete = () =>
    !hunk ||
    (oldLine === hunk.oldStart + hunk.oldCount &&
      newLine === hunk.newStart + hunk.newCount);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      if (!complete() || ++files > 1) return unavailable("unrecognized");
      hunk = undefined;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(
      line,
    );
    if (header) {
      if (!complete()) return unavailable("unrecognized");
      const [oldStart, oldCount, newStart, newCount] = [
        Number(header[1]),
        Number(header[2] ?? 1),
        Number(header[3]),
        Number(header[4] ?? 1),
      ];
      if (
        hunk &&
        (oldStart < hunk.oldStart + hunk.oldCount ||
          newStart < hunk.newStart + hunk.newCount)
      )
        return unavailable("unrecognized");
      if (
        ![
          oldStart,
          oldCount,
          newStart,
          newCount,
          oldStart + oldCount,
          newStart + newCount,
        ].every(Number.isSafeInteger)
      )
        return unavailable("unrecognized");
      hunk = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      hunks.push(hunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\ No newline at end of file"))
      hunk.lines.push({
        kind: "meta",
        text: line,
        oldLine: null,
        newLine: null,
      });
    else if (line.startsWith("+"))
      hunk.lines.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
    else if (line.startsWith("-"))
      hunk.lines.push({
        kind: "delete",
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
    else if (line.startsWith(" "))
      hunk.lines.push({
        kind: "context",
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
    else if (index !== lines.length - 1 || line)
      return unavailable("unrecognized");
  }
  if (
    !complete() ||
    (!hunks.length &&
      patch.trim() &&
      !/^(?:diff --git|index |[+-]{3} |(?:old|new) mode|similarity index|rename (?:from|to)|Binary files)/m.test(
        patch,
      ))
  )
    return unavailable("unrecognized");
  return { hunks, reason: null };
};

export const splitDiffRows = (lines: DiffLine[]) => {
  const rows: { base?: DiffLine; working?: DiffLine; meta?: string }[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++)
      rows.push({ base: removed[index], working: added[index] });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "delete") removed.push(line);
    else if (line.kind === "add") added.push(line);
    else {
      flush();
      rows.push(
        line.kind === "meta"
          ? { meta: line.text }
          : { base: line, working: line },
      );
    }
  }
  flush();
  return rows;
};
