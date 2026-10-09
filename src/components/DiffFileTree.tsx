import { useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileCode2,
  Search,
} from "lucide-react";
import type { DiffFile } from "../lib/types";
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
}: {
  files: DiffFile[];
  selected: string | undefined;
  onSelect: (file: DiffFile) => void;
  reviews?: { path: string; reviewed: boolean; notes: number }[];
}) => {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const root: TreeNode = { path: "", name: "", children: new Map() };
    for (const file of files.filter((f) =>
      f.path.toLowerCase().includes(query.toLowerCase()),
    )) {
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
  }, [files, query]);
  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const render = (node: TreeNode, depth: number): React.ReactNode =>
    Array.from(node.children.values())
      .sort(
        (a, b) =>
          Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name),
      )
      .map((child) =>
        child.file ? (
          <button
            key={child.path}
            className={`diff-file-row ${selected === child.path ? "selected" : ""}`}
            style={{ paddingLeft: 12 + depth * 12 }}
            onClick={() => onSelect(child.file!)}
            title={`${child.path}${child.file.old_path ? ` (renamed from ${child.file.old_path})` : ""}\n${child.file.staged ? "Staged changes" : ""}${child.file.untracked ? "Untracked" : child.file.unstaged ? " · Working changes" : ""}`}
            aria-current={selected === child.path ? "true" : undefined}
          >
            {reviews.find((r) => r.path === child.path)?.reviewed ? (
              <span className="success" title="Reviewed">
                ✓
              </span>
            ) : (
              <FileCode2 size={13} />
            )}
            {!!reviews.find((r) => r.path === child.path)?.notes && (
              <small title="Local review notes">
                {reviews.find((r) => r.path === child.path)?.notes} ◇
              </small>
            )}
            <span className="file-basename mono">{child.name}</span>
            <span className="file-line-stats">
              <span className="success">+{child.file.insertions}</span>
              <span className="failure">−{child.file.deletions}</span>
            </span>
            <span
              className={`file-status ${child.file.status === "D" ? "failure" : child.file.status === "A" ? "success" : "warning"}`}
            >
              {child.file.untracked ? "?" : child.file.status}
            </span>
          </button>
        ) : (
          <div key={child.path}>
            <button
              className="diff-folder-row"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => toggle(child.path)}
              aria-expanded={!collapsed.has(child.path)}
            >
              {collapsed.has(child.path) ? (
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
      {render(tree, 0)}
      {!files.length && <p className="empty-row">No changes against base.</p>}
      {files.length > 0 && tree.children.size === 0 && (
        <p className="empty-row">No matching files</p>
      )}
    </aside>
  );
};
