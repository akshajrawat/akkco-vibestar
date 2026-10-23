import { Fragment, useMemo, useState } from "react";
import type { FileDiff } from "../../lib/types";
import { highlightCode } from "../../lib/diff/highlight";
import {
  parseUnifiedDiff,
  sourceLines,
  splitDiffRows,
  type DiffLine,
} from "../../lib/diff/parse";
import { Button } from "../ui/button";

const Code = ({ text, path }: { text: string; path: string }) => (
  <code>
    {highlightCode(text, path).map((token, index) => (
      <span key={index} className={`syntax-${token.kind}`}>
        {token.text}
      </span>
    ))}
  </code>
);
const LineRows = ({
  lines,
  split,
  path,
}: {
  lines: DiffLine[];
  split: boolean;
  path: string;
}) =>
  split
    ? splitDiffRows(lines).map((row, index) =>
        row.meta ? (
          <tr className="diff-meta" key={index}>
            <td colSpan={4}>{row.meta}</td>
          </tr>
        ) : (
          <tr key={index}>
            <td className={`diff-number ${row.base?.kind || "empty"}`}>
              {row.base?.oldLine}
            </td>
            <td
              className={`diff-code ${row.base?.kind || "empty"}`}
              data-side="base"
              data-line={row.base?.oldLine}
            >
              {row.base && <Code text={row.base.text} path={path} />}
            </td>
            <td className={`diff-number ${row.working?.kind || "empty"}`}>
              {row.working?.newLine}
            </td>
            <td
              className={`diff-code ${row.working?.kind || "empty"}`}
              data-side="working"
              data-line={row.working?.newLine}
            >
              {row.working && <Code text={row.working.text} path={path} />}
            </td>
          </tr>
        ),
      )
    : lines.map((line, index) =>
        line.kind === "meta" ? (
          <tr className="diff-meta" key={index}>
            <td colSpan={4}>{line.text}</td>
          </tr>
        ) : (
          <tr className={line.kind} key={index}>
            <td className="diff-number">{line.oldLine}</td>
            <td className="diff-number">{line.newLine}</td>
            <td className="diff-sign" aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}
            </td>
            <td
              className="diff-code"
              data-side={line.kind === "delete" ? "base" : "working"}
              data-line={line.kind === "delete" ? line.oldLine : line.newLine}
            >
              <Code text={line.text} path={path} />
            </td>
          </tr>
        ),
      );

const ContextFold = ({
  original,
  modified,
  oldStart,
  newStart,
  count,
  split,
  path,
}: {
  original: string[];
  modified: string[];
  oldStart: number;
  newStart: number;
  count: number;
  split: boolean;
  path: string;
}) => {
  const [shown, setShown] = useState(0);
  const valid = useMemo(
    () =>
      count > 0 &&
      oldStart > 0 &&
      newStart > 0 &&
      oldStart + count - 1 <= original.length &&
      newStart + count - 1 <= modified.length &&
      original
        .slice(oldStart - 1, oldStart - 1 + count)
        .every((line, index) => line === modified[newStart - 1 + index]),
    [original, modified, oldStart, newStart, count],
  );
  if (!valid) return null;
  const lines = Array.from({ length: Math.min(shown, count) }, (_, index) => ({
    kind: "context" as const,
    text: original[oldStart - 1 + index],
    oldLine: oldStart + index,
    newLine: newStart + index,
  }));
  return (
    <>
      <LineRows lines={lines} split={split} path={path} />
      <tr className="diff-fold">
        <td colSpan={4}>
          {shown < count ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={shown >= 2000}
              onClick={() => setShown(Math.min(count, shown + 200))}
            >
              Show {Math.min(200, count - shown)} of {count - shown} unchanged
              lines
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setShown(0)}>
              Fold {count} unchanged lines
            </Button>
          )}
          {shown >= 2000 && shown < count && (
            <small>
              Context display is bounded. Open the complete file in your editor.
            </small>
          )}
        </td>
      </tr>
    </>
  );
};

export const DiffView = ({
  file,
  path,
  mode,
}: {
  file: FileDiff;
  path: string;
  mode: "unified" | "side";
}) => {
  const parsed = useMemo(() => parseUnifiedDiff(file.unified), [file.unified]);
  const original = useMemo(() => sourceLines(file.original), [file.original]);
  const modified = useMemo(() => sourceLines(file.modified), [file.modified]);
  const split = mode === "side";
  if (file.binary)
    return <p className="empty-row">Binary file. Review it in your editor.</p>;
  if (parsed.reason)
    return (
      <div className="diff-unavailable">
        <p>
          {parsed.reason === "oversized"
            ? "This diff exceeds the interactive view limit (750,000 characters or 12,000 lines). Open it in your editor."
            : "This patch has no reliable hunk mappings. Its original text remains available below."}
        </p>
        <details>
          <summary>View raw patch</summary>
          <pre className="change-patch">{file.unified}</pre>
        </details>
      </div>
    );
  if (!parsed.hunks.length)
    return (
      <p className="empty-row">
        {file.original === file.modified
          ? "No text changes. File identity or permissions may have changed."
          : "No mapped text patch is available. Open the file in your editor."}
      </p>
    );
  const last = parsed.hunks.at(-1)!;
  return (
    <div
      className="diff-scroll"
      tabIndex={0}
      aria-label={`${split ? "Side-by-side" : "Unified"} diff for ${path}`}
    >
      <table className={`code-diff ${split ? "split" : "unified"}`}>
        <caption className="sr-only">
          {path} · base and working line numbers
        </caption>
        <colgroup>
          <col className="number-column" />
          {split ? (
            <>
              <col />
              <col className="number-column" />
              <col />
            </>
          ) : (
            <>
              <col className="number-column" />
              <col className="sign-column" />
              <col />
            </>
          )}
        </colgroup>
        <thead>
          <tr>
            {split ? (
              <>
                <th colSpan={2}>Base</th>
                <th colSpan={2}>Working</th>
              </>
            ) : (
              <>
                <th>Old</th>
                <th>New</th>
                <th colSpan={2}>Change</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {parsed.hunks.map((hunk, index) => {
            const previous = parsed.hunks[index - 1];
            const oldStart = previous
              ? previous.oldStart + previous.oldCount
              : 1;
            const newStart = previous
              ? previous.newStart + previous.newCount
              : 1;
            const gap = hunk.oldStart - oldStart;
            return (
              <Fragment key={`${hunk.header}:${index}`}>
                {gap > 0 && gap === hunk.newStart - newStart && (
                  <ContextFold
                    original={original}
                    modified={modified}
                    oldStart={oldStart}
                    newStart={newStart}
                    count={gap}
                    split={split}
                    path={path}
                  />
                )}
                <tr className="diff-hunk">
                  <td colSpan={4}>{hunk.header}</td>
                </tr>
                <LineRows lines={hunk.lines} split={split} path={path} />
              </Fragment>
            );
          })}
          {original.length - (last.oldStart + last.oldCount - 1) ===
            modified.length - (last.newStart + last.newCount - 1) && (
            <ContextFold
              original={original}
              modified={modified}
              oldStart={last.oldStart + last.oldCount}
              newStart={last.newStart + last.newCount}
              count={original.length - (last.oldStart + last.oldCount - 1)}
              split={split}
              path={path}
            />
          )}
        </tbody>
      </table>
    </div>
  );
};
