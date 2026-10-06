import { useEffect, useState } from "react";
import { Send, Trash2, MessageSquare } from "lucide-react";
import type { ReviewNote } from "../../backend/review/service";
import { rpc, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
export const DiffReview = ({
  taskId,
  path,
  oldPath,
  selection,
  revision,
  onError,
}: {
  taskId: string;
  path: string;
  oldPath?: string | null;
  selection: { start: number; end: number; side: "base" | "working" };
  revision: number;
  onError: (message: string) => void;
}) => {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    void rpc<ReviewNote[]>("review.list", { id: taskId })
      .then((rows) => {
        if (alive) setNotes(rows);
      })
      .catch((e) => onError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [taskId, revision, refresh, onError]);
  const action = async (method: string, params: unknown) => {
    setBusy(true);
    try {
      await rpc(method, params);
      setRefresh((n) => n + 1);
      if (method === "review.add") setContent("");
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="diff-review">
      <div className="section-heading">
        <strong>
          <MessageSquare size={13} />
          Local review · {notes.length} notes
        </strong>
        <Button
          size="sm"
          disabled={busy || !notes.length}
          onClick={() => void action("review.send", { id: taskId })}
        >
          <Send size={12} />
          Send feedback to Codex
        </Button>
      </div>
      <div className="diff-review-notes">
        {notes
          .filter((n) => n.path === path || n.path === oldPath)
          .map((note) => (
            <article key={note.id}>
              <code>
                {note.side} · {note.path}:{note.line_start}
                {note.line_end !== note.line_start ? `–${note.line_end}` : ""}
              </code>
              <p>{note.content}</p>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete review note"
                onClick={() => {
                  if (window.confirm("Delete this saved local review note?"))
                    void action("review.remove", {
                      id: note.id,
                      confirmed: true,
                    });
                }}
              >
                <Trash2 size={12} />
              </Button>
            </article>
          ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action("review.add", {
            id: taskId,
            path,
            old_path: oldPath,
            side: selection.side,
            line_start: selection.start,
            line_end: selection.end,
            content,
          });
        }}
      >
        <code>
          {selection.side} · selected lines {selection.start}–{selection.end}
        </code>
        <textarea
          aria-label="Local diff review note"
          placeholder="Select code lines above and add local feedback…"
          rows={2}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={8000}
        />
        <Button size="sm" disabled={busy || !content.trim()} type="submit">
          Save note
        </Button>
      </form>
      <small className="subtle">
        Notes stay in SQLite. Sending feedback explicitly starts a new Codex
        continuation in this worktree; nothing is posted to GitHub.
      </small>
    </section>
  );
};
