import { randomUUID } from "node:crypto";
import type { z } from "zod";

import { AdeError, now } from "../domain";
import type { Database } from "../storage/database";
import { FlowStore } from "../flows/store";
import { ConversationSelectionSchema, agentPrompt } from "../flows/run-contracts";
import { redact } from "../execution/runtime/process";
import { ConversationOutputSchema, type AgentExecution } from "../execution/contracts";
import {
  ViberMessageSchema,
  ViberMessageSnapshotSchema,
  ViberSessionCreateSchema,
  ViberSessionSchema,
  ViberSessionScopeSchema,
  ViberSessionSendSchema,
  type ViberSessionDetail,
} from "./contracts";

/** Session ownership and captured turns are independent of Tasks and Flow revisions. */
export class ViberSessionStore {
  constructor(private readonly db: Database) {}

  create = (raw: z.input<typeof ViberSessionCreateSchema>) => {
    const input = ViberSessionCreateSchema.parse(raw);
    return this.db.transaction(() => {
      const previous = this.db.all<{ configuration: string }>(
        "SELECT configuration FROM viber_sessions WHERE id=?",
        input.request_id,
      )[0];

      if (previous) {
        if (previous.configuration !== JSON.stringify(input)) {
          throw new AdeError(
            "request_conflict",
            "This session request belongs to another Viber or selection.",
          );
        }

        return this.session(input.request_id, input.profile_id);
      }

      if (
        this.db.all(
          "SELECT profile_id FROM retired_viber_profiles WHERE profile_id=?",
          input.profile_id,
        ).length
      ) {
        throw new AdeError("invalid_state", "Select an active Viber profile for a new session.");
      }

      const profile = new FlowStore(this.db).profile(input.profile_id);
      const selection = ConversationSelectionSchema.parse(input.selection || profile.execution);
      const timestamp = now();

      this.db.run(
        "INSERT INTO viber_sessions VALUES(?,?,?,?,?,?,?)",
        input.request_id,
        profile.id,
        "New chat",
        JSON.stringify(selection),
        JSON.stringify(input),
        timestamp,
        timestamp,
      );

      return this.session(input.request_id, profile.id);
    });
  };

  session = (sessionId: string, profileId: string) => {
    ViberSessionScopeSchema.parse({ session_id: sessionId, profile_id: profileId });

    const row = this.db.all<{ selection: string }>(
      "SELECT * FROM viber_sessions WHERE id=? AND profile_id=?",
      sessionId,
      profileId,
    )[0];

    if (!row) {
      throw new AdeError("not_found", "Viber session not found for this profile.");
    }

    return ViberSessionSchema.parse({ ...row, selection: JSON.parse(row.selection) });
  };

  list = (profileId: string) =>
    this.db
      .all<{ id: string }>(
        "SELECT id FROM viber_sessions WHERE profile_id=? ORDER BY updated_at DESC,rowid DESC",
        profileId,
      )
      .map(({ id }) => this.session(id, profileId));

  detail = (sessionId: string, profileId: string): ViberSessionDetail => ({
    session: this.session(sessionId, profileId),
    messages: this.db
      .all("SELECT * FROM viber_messages WHERE session_id=? ORDER BY rowid", sessionId)
      .map((row) => ViberMessageSchema.parse(row)),
  });

  previous = (input: z.output<typeof ViberSessionSendSchema>) => {
    this.session(input.session_id, input.profile_id);

    const row = this.db.all<{ configuration: string }>(
      "SELECT * FROM viber_messages WHERE id=?",
      input.request_id,
    )[0];

    if (!row) {
      return null;
    }

    const snapshot = row.configuration
      ? ViberMessageSnapshotSchema.parse(JSON.parse(row.configuration))
      : null;

    if (!snapshot || JSON.stringify(snapshot.request) !== JSON.stringify(input)) {
      throw new AdeError(
        "request_conflict",
        "This message request belongs to another session or message.",
      );
    }

    return ViberMessageSchema.parse(row);
  };

  capture = (raw: z.input<typeof ViberSessionSendSchema>) =>
    this.db.transaction(() => {
      const input = ViberSessionSendSchema.parse(raw);
      const session = this.session(input.session_id, input.profile_id);
      if (
        this.db.all(
          "SELECT id FROM viber_messages WHERE session_id=? AND status='pending'",
          session.id,
        ).length
      ) {
        throw new AdeError(
          "busy",
          "Wait for this Viber session to finish before sending another message.",
        );
      }

      const profile = new FlowStore(this.db).profile(session.profile_id);
      const selection = input.selection || session.selection;
      const execution = { ...profile.execution, ...selection, output: "conversation" as const };

      const history = input.history_ids.map((id) => {
        const row = this.db.all<{ role: string; content: string }>(
          "SELECT role,content FROM viber_messages WHERE id=? AND session_id=? AND status='completed'",
          id,
          session.id,
        )[0];

        if (!row) {
          throw new AdeError("context", "Select completed messages from this Viber session only.");
        }

        return { role: row.role, content: row.content };
      });

      const prompt = agentPrompt(profile.instructions, [
        ...history,
        { role: "user", content: input.content },
      ]);

      const snapshot = ViberMessageSnapshotSchema.parse({
        request: input,
        profile,
        execution,
        prompt,
      });

      this.db.run(
        "INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at) VALUES(?,?,'user',?,'pending',?,?)",
        input.request_id,
        session.id,
        redact(input.content),
        JSON.stringify(snapshot),
        now(),
      );

      this.db.run(
        "UPDATE viber_sessions SET selection=?,title=CASE WHEN NOT EXISTS(SELECT 1 FROM viber_messages WHERE session_id=? AND id<>?) THEN ? ELSE title END,updated_at=? WHERE id=?",
        JSON.stringify(selection),
        session.id,
        input.request_id,
        redact(input.content).slice(0, 90),
        now(),
        session.id,
      );

      return snapshot;
    });

  assertExecution = (
    sessionId: string,
    messageId: string,
    execution: AgentExecution,
    prompt: string,
  ) => {
    const row = this.db.all<{ configuration: string }>(
      "SELECT configuration FROM viber_messages WHERE id=? AND session_id=? AND role='user' AND status='pending' AND run_id IS NULL",
      messageId,
      sessionId,
    )[0];

    const snapshot = row ? ViberMessageSnapshotSchema.parse(JSON.parse(row.configuration)) : null;
    if (
      !snapshot ||
      JSON.stringify(snapshot.execution) !== JSON.stringify(execution) ||
      snapshot.prompt !== prompt
    ) {
      throw new AdeError(
        "isolation",
        "Viber execution must match its unconsumed message snapshot.",
      );
    }
  };

  finish = (
    messageId: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    output?: unknown,
    error?: string,
  ) =>
    this.db.transaction(() => {
      const row = this.db.all<{ session_id: string; run_id: string | null }>(
        "SELECT session_id,run_id FROM viber_messages WHERE id=? AND status='pending'",
        messageId,
      )[0];

      if (!row) {
        return;
      }

      this.db.run(
        "UPDATE viber_messages SET status=?,error=? WHERE id=?",
        status,
        error ? redact(error).slice(0, 32000) : null,
        messageId,
      );

      if (status === "completed") {
        this.db.run(
          "INSERT INTO viber_messages(id,session_id,role,content,status,run_id,created_at) VALUES(?,?,'assistant',?,'completed',?,?)",
          randomUUID(),
          row.session_id,
          redact(ConversationOutputSchema.parse(output).summary),
          row.run_id,
          now(),
        );
      }

      this.db.run("UPDATE viber_sessions SET updated_at=? WHERE id=?", now(), row.session_id);
    });
}
