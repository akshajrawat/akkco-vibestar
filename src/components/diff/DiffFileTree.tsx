import { useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileCode2,
  Search,
} from "lucide-react";
import type { DiffFile } from "../../lib/types";
interface TreeNode {
  path: string;
  name: string;
  children: Map<string, TreeNode>;
  file?: DiffFile;
}
export const DiffFileTree = ({
  files,
  selected,
  onSelect,
  reviews = [],
  mode = "tree",
  onMode,
}: {
  files: DiffFile[];
  selected: string | undefined;
  onSelect: (file: DiffFile) => void;
  reviews?: { path: string; reviewed: boolean; notes: number }[];
  mode?: "tree" | "flat";
  onMode?: (mode: "tree" | "flat") => void;
}) => {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const visibleFiles = useMemo(
    () =>
      files.filter((file) =>
        `${file.path} ${file.old_path || ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [files, query],
  );
  const tree = useMemo(() => {
    const root: TreeNode = { path: "", name: "", children: new Map() };
    for (const file of visibleFiles) {
      let parent = root;
      const parts = file.path.split("/");
      parts.forEach((name, index) => {
        const path = parts.slice(0, index + 1).join("/");
        let node = parent.children.get(name);
        if (!node) {
          node = { path, name, children: new Map() };
          parent.children.set(name, node);
        }
        if (index === parts.length - 1) node.file = file;
        parent = node;
      });
    }
    return root;
  }, [visibleFiles]);
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const renderFile = (file: DiffFile, depth: number) => (
    <button
      key={file.path}
      aria-label={`${file.path} · ${file.untracked ? "Added" : file.status.startsWith("R") ? "Renamed" : file.status === "D" ? "Deleted" : file.status === "A" ? "Added" : "Modified"} · +${file.insertions} −${file.deletions}${reviews.find((row) => row.path === file.path)?.reviewed ? " · Reviewed" : ""}`}
      className={`diff-file-row ${selected === file.path ? "selected" : ""}`}
      style={{ paddingLeft: 12 + depth * 12 }}
      onClick={() => onSelect(file)}
      title={`${file.path}${file.old_path ? ` (renamed from ${file.old_path})` : ""}\n${file.staged ? "Staged changes" : ""}${file.untracked ? "Untracked" : file.unstaged ? " · Working changes" : ""}`}
      aria-current={selected === file.path ? "true" : undefined}
    >
      {reviews.find((r) => r.path === file.path)?.reviewed ? (
        <span className="success" title="Reviewed">
          ✓
        </span>
      ) : (
        <FileCode2 size={13} />
      )}
      {!!reviews.find((r) => r.path === file.path)?.notes && (
        <small title="Local review notes">
          {reviews.find((r) => r.path === file.path)?.notes} ◇
        </small>
      )}
      <span className="file-identity">
        <span className="file-basename mono">
          {file.path.split("/").at(-1)}
        </span>
        {mode === "flat" && (
          <small>
            {file.path.includes("/")
              ? file.path.slice(0, file.path.lastIndexOf("/"))
              : "."}
          </small>
        )}
        {file.old_path && <small>from {file.old_path}</small>}
      </span>
      {file.binary && <small>Binary</small>}
      <span className="file-line-stats">
        <span className="success">+{file.insertions}</span>
        <span className="failure">−{file.deletions}</span>
      </span>
      <span
        className={`file-status ${file.status === "D" ? "failure" : file.status === "A" ? "success" : "warning"}`}
      >
        {file.untracked ? "?" : file.status}
      </span>
    </button>
  );
  const render = (node: TreeNode, depth: number): React.ReactNode =>
    Array.from(node.children.values())
      .sort(
        (a, b) =>
          Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name),
      )
      .map((child) =>
        child.file ? (
          renderFile(child.file, depth)
        ) : (
          <div key={child.path}>
            <button
              className="diff-folder-row"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => toggle(child.path)}
              aria-expanded={!!query || !collapsed.has(child.path)}
            >
              {collapsed.has(child.path) && !query ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              <Folder size={13} />
              <span>{child.name}</span>
            </button>
            {(!collapsed.has(child.path) || query) && render(child, depth + 1)}
          </div>
        ),
      );
  return (
    <aside className="file-tree">
      <div className="file-tree-caption">
        CHANGES <span>{files.length}</span>
        {onMode && (
          <button
            type="button"
            className="file-mode-toggle"
            aria-label={
              mode === "tree" ? "Show flat file list" : "Show file tree"
            }
            onClick={() => onMode(mode === "tree" ? "flat" : "tree")}
          >
            {mode === "tree" ? "Flat" : "Tree"}
          </button>
        )}
      </div>
      <div className="file-search">
        <Search size={12} />
        <input
          aria-label="Filter changed files"
          placeholder="Filter files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {mode === "flat"
        ? visibleFiles
            .slice()
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((file) => renderFile(file, 0))
        : render(tree, 0)}
      {!files.length && <p className="empty-row">No changes against base.</p>}
      {files.length > 0 && tree.children.size === 0 && (
        <p className="empty-row">No matching files</p>
      )}
    </aside>
  );
};
