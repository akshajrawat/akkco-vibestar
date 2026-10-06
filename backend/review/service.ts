import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { AdeError, now } from "../domain";
import { redact } from "../execution/process";
import type { Engine } from "../execution/engine";
const noteInput = z
  .object({
    id: z.string().uuid(),
    path: z.string().max(4000),
    old_path: z.string().max(4000).nullable().optional(),
    side: z.enum(["base", "working"]),
    line_start: z.number().int().min(1).max(10000000),
    line_end: z.number().int().min(1).max(10000000),
    content: z.string().trim().min(1).max(8000),
  })
  .refine((p) => p.line_end >= p.line_start, "Invalid line range");
export interface ReviewNote {
  id: string;
  task_id: string;
  path: string;
  side: "base" | "working";
  line_start: number;
  line_end: number;
  content: string;
  source_hash: string;
  created_at: string;
}
export class ReviewService {
  constructor(private readonly engine: Engine) {}
  list = (id: string) => {
    this.engine.db.task(id);
    return this.engine.db.all<ReviewNote>(
      "SELECT * FROM task_review_notes WHERE task_id=? ORDER BY created_at",
      id,
    );
  };
  add = async (input: unknown) => {
    const p = noteInput.parse(input);
    const task = this.engine.db.task(p.id);
    const file = await this.engine.git.file(task, p.path, p.old_path);
    if (file.binary)
      throw new AdeError(
        "invalid_input",
        "Text review notes require a text file",
      );
    const note: ReviewNote = {
      id: randomUUID(),
      task_id: p.id,
      path: p.side === "base" ? p.old_path || p.path : p.path,
      side: p.side,
      line_start: p.line_start,
      line_end: p.line_end,
      content: redact(p.content),
      source_hash: createHash("sha256")
        .update(p.side === "base" ? file.original : file.modified)
        .digest("hex"),
      created_at: now(),
    };
    this.engine.db.run(
      "INSERT INTO task_review_notes VALUES(?,?,?,?,?,?,?,?,?)",
      note.id,
      note.task_id,
      note.path,
      note.side,
      note.line_start,
      note.line_end,
      note.content,
      note.source_hash,
      note.created_at,
    );
    this.engine.changed(p.id);
    return note;
  };
  remove = (id: string) => {
    this.engine.db.run("DELETE FROM task_review_notes WHERE id=?", id);
    this.engine.changed();
  };
  send = (id: string) => {
    const notes = this.list(id);
    if (!notes.length)
      throw new AdeError("invalid_state", "No saved local review notes");
    return this.engine.followUp(
      id,
      `Apply my local diff review feedback within this task's claimed scope. Notes are local, not GitHub comments. Their paths, line ranges, side and source hashes describe the version reviewed; inspect current files and account for any drift before acting. Do not push, post comments, create PRs or merge.\n${JSON.stringify(notes)}`,
    );
  };
}
