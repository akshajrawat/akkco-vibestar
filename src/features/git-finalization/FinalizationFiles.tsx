import { FileCheck2 } from "lucide-react";

import { Button } from "../../components/ui/button";
import type { FinalizationController, GitFinalizationProps } from "./useGitFinalization";

/** Renders the files portion without owning operation authority or duplicating wizard state. */
export const FinalizationFiles = ({
  controller,
  snapshot,
}: {
  controller: Pick<
    FinalizationController,
    | "selection"
    | "fileSearch"
    | "setFileSearch"
    | "filteredFiles"
    | "locked"
    | "invalidate"
    | "setSelection"
    | "stagedSelection"
    | "replaceStaged"
    | "setReplaceStaged"
    | "record"
  >;
  snapshot: NonNullable<FinalizationController["snapshot"]>;
} & Pick<GitFinalizationProps, "task">) => {
  const {
    selection,
    fileSearch,
    setFileSearch,
    filteredFiles,
    locked,
    invalidate,
    setSelection,
    stagedSelection,
    replaceStaged,
    setReplaceStaged,
    record,
  } = controller;

  return (
    <section className="git-files-panel">
      <h3>
        <FileCheck2 size={17} /> Changed files{" "}
        <span className="badge">
          {selection.filter((path) => snapshot.files.some((file) => file.path === path)).length}{" "}
          selected
        </span>
      </h3>

      <Button
        size="sm"
        variant="ghost"
        disabled={locked || !!record?.head}
        onClick={() => {
          invalidate();
          setSelection(snapshot.files.filter((file) => !file.excluded).map((file) => file.path));
        }}
      >
        Select all eligible files
      </Button>

      <label>
        <span className="sr-only">Search changed files</span>
        <input
          type="search"
          value={fileSearch}
          placeholder="Search changed files…"
          onChange={(event) => setFileSearch(event.target.value)}
        />
      </label>

      <ul className="git-file-list">
        {filteredFiles.map((file) => (
          <li key={file.path} className={file.excluded ? "excluded" : undefined}>
            <label>
              <input
                type="checkbox"
                checked={selection.includes(file.path)}
                disabled={locked || !!record?.head || !!file.excluded || file.committed}
                onChange={(event) => {
                  invalidate();

                  setSelection(
                    event.target.checked
                      ? [...selection, file.path]
                      : selection.filter((path) => path !== file.path),
                  );
                }}
              />

              <span>
                <code>
                  {file.old_path ? `${file.old_path} → ` : ""}
                  {file.path}
                </code>

                <small>
                  {file.status} ·{" "}
                  {file.committed
                    ? "Already committed · included"
                    : file.untracked
                      ? "New file"
                      : file.staged
                        ? "Existing staged changes"
                        : "Working change"}{" "}
                  · {file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`} ·
                  +{file.insertions} / −{file.deletions}
                  {file.binary ? " · Binary" : ""}
                </small>
              </span>
            </label>
            {file.excluded && <small className="error-text">{file.excluded}</small>}
          </li>
        ))}
      </ul>

      {fileSearch && !filteredFiles.length && (
        <p className="muted">No matching files. Your selection is preserved.</p>
      )}

      {!snapshot.files.length && (
        <p className="muted">No changed files. Saved operation history remains available below.</p>
      )}

      {!!snapshot.ignored.length && (
        <details>
          <summary>
            Ignored files ({snapshot.ignored.length}
            {snapshot.ignored.length === 200 ? "+" : ""})
          </summary>
          <p className="muted">Ignored files cannot be selected.</p>
          <ul>
            {snapshot.ignored.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {stagedSelection && (
        <label className="inline-check">
          <input
            type="checkbox"
            checked={replaceStaged}
            disabled={locked}
            onChange={(event) => setReplaceStaged(event.target.checked)}
          />
          Use complete selected files instead of their existing staged hunks. Preserve other staged
          files.
        </label>
      )}
    </section>
  );
};
