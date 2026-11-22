import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { AdeError, now, type WorkspaceAssignment } from "../domain";
import type { Database } from "../storage/database";
import { redact } from "../execution/runtime/process";
import { ConversationOutputSchema, type AgentExecution } from "../execution/contracts";
import {
  AgentProfileSchema,
  ConversationSelectionSchema,
  ViberMessageSchema,
  ViberMessageSnapshotSchema,
  ViberSessionCreateSchema,
  ViberSessionSchema,
  ViberSessionScopeSchema,
  ViberSessionSendSchema,
  ViberThreadSchema,
  ViberWorkspaceSchema,
  agentPrompt,
  continueLabel,
  type AgentProfile,
  type ViberMessagePreview,
  type ViberSessionDetail,
  type ViberWorkspace,
} from "./contracts";

const identity = z.string().uuid();

const freshContinuationPrompt = (originalPrompt: string) =>
  `Original user prompt:\n${originalPrompt}\n\nThe previous thread couldn’t be resumed. Inspect the current workspace and any partial edits, then continue from where it left off.`;

const threadConfiguration = (
  execution: AgentExecution,
  instructions: string,
  legacyModel?: string,
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        provider: execution.provider,
        model: legacyModel,
        access: execution.access,
        instructions,
      }),
    )
    .digest("hex");

/** Viber profiles and appearances store. */
export class ViberStore {
  constructor(private readonly db: Database) {}

  saveProfile = (input: AgentProfile, expectedRevision: number | null) => {
    const profile = AgentProfileSchema.parse(input);
    if (profile.revision !== (expectedRevision || 0) + 1) {
      throw new AdeError("invalid_input", "Profile revisions must advance by one.");
    }

    return this.db.transaction(() => {
      this.assertProfileRevision(profile.id, expectedRevision);
      const timestamp = now();

      this.db.run(
        "INSERT INTO agent_profiles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_revision=excluded.current_revision,updated_at=excluded.updated_at",
        profile.id,
        profile.revision,
        timestamp,
        timestamp,
      );

      this.db.run(
        "INSERT INTO agent_profile_revisions VALUES(?,?,?,?)",
        profile.id,
        profile.revision,
        JSON.stringify(profile),
        timestamp,
      );

      return profile;
    });
  };

  profile = (id: string, revision?: number) => {
    identity.parse(id);

    const row = this.db.all<{ revision: number; data: string }>(
      "SELECT r.revision,r.data FROM agent_profile_revisions r JOIN agent_profiles p ON p.id=r.profile_id WHERE p.id=? AND r.revision=COALESCE(?,p.current_revision)",
      id,
      revision ?? null,
    )[0];

    if (!row) {
      throw new AdeError("not_found", "Agent profile revision not found.");
    }

    return this.db.records.decode(
      {
        table: "agent_profile_revisions",
        id: `${id}:${row.revision}`,
        column: "data",
        source: row.data,
      },
      (value) => {
        const profile = AgentProfileSchema.parse(value);
        if (profile.id !== id || profile.revision !== row.revision) {
          throw new Error("Profile identity mismatch.");
        }

        return profile;
      },
    );
  };

  listProfiles = () =>
    this.db
      .all<{ id: string }>(
        "SELECT id FROM agent_profiles WHERE id NOT IN (SELECT profile_id FROM retired_viber_profiles) ORDER BY created_at,id",
      )
      .flatMap(({ id }) => {
        try {
          return [this.profile(id)];
        } catch (error) {
          if (error instanceof AdeError && error.kind === "corrupt_record") {
            return [];
          }

          throw error;
        }
      });

  private assertProfileRevision = (id: string, expected: number | null) => {
    if (expected !== null) {
      z.number().int().positive().parse(expected);
    }

    const row = this.db.all<{ current_revision: number }>(
      "SELECT current_revision FROM agent_profiles WHERE id=?",
      id,
    )[0];

    if ((row?.current_revision ?? null) !== expected) {
      throw new AdeError(
        "stale_configuration",
        "The saved configuration changed. Reload it before applying your edits.",
      );
    }

    return row;
  };
}

/** Session ownership and captured turns are independent of Tasks and Flow revisions. */
export class ViberSessionStore {
  readonly profiles: ViberStore;

  constructor(private readonly db: Database) {
    this.profiles = new ViberStore(db);
  }

  create = (raw: z.input<typeof ViberSessionCreateSchema>) => {
    const input = ViberSessionCreateSchema.parse(raw);
    return this.db.transaction(() => {
      const previous = this.db.all<{ profile_id: string; configuration: string }>(
        "SELECT profile_id, configuration FROM viber_sessions WHERE id=?",
        input.request_id,
      )[0];

      if (previous) {
        if (
          previous.configuration !== JSON.stringify(input) ||
          previous.profile_id !== input.profile_id
        ) {
          throw new AdeError(
            "request_conflict",
            "This session request belongs to another Viber or selection.",
          );
        }

        return this.session(input.request_id, input.profile_id);
      }

      const existing = this.db.all<{ id: string }>(
        "SELECT id FROM viber_sessions WHERE profile_id=?",
        input.profile_id,
      )[0];

      if (existing) {
        throw new AdeError(
          "duplicate_session",
          "Each Viber owns exactly one continuous conversation.",
        );
      }

      if (
        this.db.all(
          "SELECT profile_id FROM retired_viber_profiles WHERE profile_id=?",
          input.profile_id,
        ).length
      ) {
        throw new AdeError("invalid_state", "Select an active Viber profile for a new session.");
      }

      const profile = this.profiles.profile(input.profile_id);

      const selection = ConversationSelectionSchema.parse(
        input.selection || {
          provider: profile.execution.provider,
          model: profile.execution.model,
          effort: profile.execution.effort,
        },
      );

      const timestamp = now();
      const repo = input.repository_id ? this.db.repository(input.repository_id) : null;
      if (repo && (repo.connected === false || repo.clone_status === "cloning")) {
        throw new AdeError("repository_missing", "Select a connected, ready repository.");
      }

      const workspace: ViberWorkspace = {
        id: randomUUID(),
        repo_id: repo?.id ?? null,
        kind: "general",
        goal: "Viber session",
        branch_name: "",
        base_branch: repo?.base_branch || "",
        base_commit_sha: "",
        worktree_path: "",
        ...(repo ? {} : { workspace_kind: "managed" as const }),
        created_at: timestamp,
        updated_at: timestamp,
        status: "not_started",
        stage: 0,
        error: null,
      };

      this.db.run(
        "INSERT INTO viber_sessions(id,profile_id,title,selection,configuration,created_at,updated_at,repository_id,workspace) VALUES(?,?,?,?,?,?,?,?,?)",
        input.request_id,
        profile.id,
        "New chat",
        JSON.stringify(selection),
        JSON.stringify(input),
        timestamp,
        timestamp,
        repo?.id ?? null,
        JSON.stringify(workspace),
      );

      return this.session(input.request_id, profile.id);
    });
  };

  session = (sessionId: string, profileId: string) => {
    ViberSessionScopeSchema.parse({ session_id: sessionId, profile_id: profileId });

    const row = this.db.all<{ selection: string; thread: string | null; threads?: string | null }>(
      "SELECT * FROM viber_sessions WHERE id=? AND profile_id=?",
      sessionId,
      profileId,
    )[0];

    if (!row) {
      throw new AdeError("not_found", "Viber session not found for this profile.");
    }

    const legacyThread = row.thread ? JSON.parse(row.thread) : null;
    let threads: Record<string, z.infer<typeof ViberThreadSchema>> = {};
    if (row.threads) {
      try {
        threads = JSON.parse(row.threads);
      } catch {
        threads = {};
      }
    } else if (legacyThread?.provider) {
      threads[legacyThread.provider] = legacyThread;
    }

    return ViberSessionSchema.parse({
      ...row,
      selection: JSON.parse(row.selection),
      thread: legacyThread,
      threads,
    });
  };

  workspace = (sessionId: string): ViberWorkspace => {
    const row = this.db.all<{ repository_id: string | null; workspace: string | null }>(
      "SELECT repository_id,workspace FROM viber_sessions WHERE id=?",
      sessionId,
    )[0];

    if (!row?.workspace) {
      throw new AdeError(
        "recovery",
        "This legacy session has no owned workspace. Start a new chat and select its repository; old files and messages are preserved.",
      );
    }

    const workspace = ViberWorkspaceSchema.parse(JSON.parse(row.workspace));
    if (
      workspace.kind !== "general" ||
      workspace.repo_id !== row.repository_id ||
      workspace.workspace_mode ||
      !workspace.id ||
      workspace.id === sessionId
    ) {
      throw new AdeError("ownership", "Viber workspace does not match its saved session.");
    }

    return workspace;
  };

  saveWorkspace = (sessionId: string, workspace: ViberWorkspace | WorkspaceAssignment) => {
    const previous = this.workspace(sessionId);
    if (workspace.id !== previous.id || workspace.repo_id !== previous.repo_id) {
      throw new AdeError("ownership", "Viber workspace ownership changed.");
    }

    this.db.run(
      "UPDATE viber_sessions SET workspace=? WHERE id=?",
      JSON.stringify(ViberWorkspaceSchema.parse({ ...previous, ...workspace })),
      sessionId,
    );
  };

  list = (profileId: string) =>
    this.db
      .all<{ id: string }>(
        "SELECT id FROM viber_sessions WHERE profile_id=? ORDER BY updated_at DESC,rowid DESC",
        profileId,
      )
      .map(({ id }) => this.session(id, profileId));

  messagePreviews = () =>
    this.db.all<ViberMessagePreview>(`
      SELECT s.profile_id, substr(m.content, 1, 280) AS content, m.created_at
      FROM viber_sessions s
      JOIN viber_messages m ON m.id = (
        SELECT id FROM viber_messages
        WHERE session_id = s.id
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      )
      WHERE s.profile_id NOT IN (SELECT profile_id FROM retired_viber_profiles)
    `);

  continuousSession = (profileId: string, repositoryId?: string) => {
    identity.parse(profileId);

    const existing = this.db.all<{ id: string }>(
      "SELECT id FROM viber_sessions WHERE profile_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1",
      profileId,
    )[0];

    if (existing) {
      return this.session(existing.id, profileId);
    }

    return this.create({
      request_id: randomUUID(),
      profile_id: profileId,
      repository_id: repositoryId,
    });
  };

  detail = (sessionId: string, profileId: string): ViberSessionDetail => {
    const session = this.session(sessionId, profileId);

    return {
      session,
      recovery_required: this.requiresRecovery(sessionId, profileId),
      messages: this.db
        .all(
          "SELECT *,json_extract(configuration,'$.request.continue_message_id') AS continue_message_id FROM viber_messages WHERE session_id=? ORDER BY rowid",
          sessionId,
        )
        .map((row) => ViberMessageSchema.parse(row)),
    };
  };

  requiresRecovery = (sessionId: string, profileId: string) => {
    const session = this.session(sessionId, profileId);

    const last = this.db.all<{ status: string; effects: string }>(
      "SELECT status,effects FROM viber_messages WHERE session_id=? AND role='user' ORDER BY rowid DESC LIMIT 1",
      sessionId,
    )[0];

    return (
      session.thread?.status === "uncertain" ||
      !!(last && last.status !== "completed" && last.effects !== "none")
    );
  };

  markInvocation = (messageId: string) => {
    this.db.run(
      "UPDATE viber_messages SET effects='possible' WHERE id=? AND status='pending'",
      messageId,
    );
  };

  previous = (input: z.output<typeof ViberSessionSendSchema>) => {
    this.session(input.session_id, input.profile_id);

    const row = this.db.all<{
      configuration: string | null;
      session_id: string;
      role: string;
      content: string;
      status: string;
    }>(
      "SELECT *,json_extract(configuration,'$.request.continue_message_id') AS continue_message_id FROM viber_messages WHERE id=?",
      input.request_id,
    )[0];

    if (!row) {
      return null;
    }

    if (
      row.configuration === null &&
      row.session_id === input.session_id &&
      row.role === "user" &&
      row.status === "completed" &&
      row.content === "/clear" &&
      input.content === "/clear" &&
      !input.continue_message_id
    ) {
      return ViberMessageSchema.parse(row);
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

  private writableSession = (sessionId: string, profileId: string) => {
    const session = this.session(sessionId, profileId);
    if (
      this.db.all("SELECT profile_id FROM retired_viber_profiles WHERE profile_id=?", profileId)
        .length
    ) {
      throw new AdeError("not_found", "This Viber was deleted.");
    }

    if (
      this.db.all(
        "SELECT id FROM viber_messages WHERE session_id=? AND status='pending'",
        sessionId,
      ).length
    ) {
      throw new AdeError(
        "busy",
        "Wait for this Viber session to finish before sending another message.",
      );
    }

    return session;
  };

  clearContext = (sessionId: string, profileId: string, requestId: string) =>
    this.db.transaction(() => {
      this.writableSession(sessionId, profileId);
      const timestamp = now();

      this.db.run(
        "UPDATE viber_sessions SET thread=NULL,threads=NULL,updated_at=? WHERE id=?",
        timestamp,
        sessionId,
      );

      this.db.run(
        "INSERT INTO viber_messages(id,session_id,role,content,status,created_at,effects) VALUES(?,?,'user','/clear','completed',?,'none')",
        requestId,
        sessionId,
        timestamp,
      );

      this.db.run(
        "INSERT INTO viber_messages(id,session_id,role,content,status,created_at) VALUES(?,?,'assistant',?,'completed',?)",
        randomUUID(),
        sessionId,
        "Conversation context reset. Saved history and workspace files have been preserved.",
        timestamp,
      );

      return ViberMessageSchema.parse(
        this.db.all("SELECT * FROM viber_messages WHERE id=?", requestId)[0],
      );
    });

  capture = (raw: z.input<typeof ViberSessionSendSchema>) =>
    this.db.transaction(() => {
      const input = ViberSessionSendSchema.parse(raw);
      const session = this.writableSession(input.session_id, input.profile_id);

      let interrupted;
      if (input.continue_message_id) {
        const previous = this.db.all<{
          id: string;
          status: string;
          content: string;
          configuration: string | null;
          conversation_id: string | null;
        }>(
          "SELECT m.id,m.status,m.content,m.configuration,r.conversation_id FROM viber_messages m LEFT JOIN utility_runs r ON r.id=m.run_id WHERE m.session_id=? AND m.role='user' ORDER BY m.rowid DESC LIMIT 1",
          session.id,
        )[0];

        if (
          previous?.id !== input.continue_message_id ||
          !["cancelled", "interrupted"].includes(previous.status) ||
          input.content !== continueLabel ||
          input.history_ids.length ||
          input.new_thread ||
          input.selection
        ) {
          throw new AdeError(
            "recovery",
            "Continue must target the latest stopped or interrupted turn.",
          );
        }

        const previousSnapshot = previous.configuration
          ? ViberMessageSnapshotSchema.parse(JSON.parse(previous.configuration))
          : null;

        interrupted = {
          originalPrompt: previousSnapshot?.originalPrompt ?? previous.content,
          threadId: previous.conversation_id,
        };
      }

      const profile = this.profiles.profile(session.profile_id);
      const selection = input.selection || session.selection;
      const execution = { ...profile.execution, ...selection, output: "conversation" as const };
      this.workspace(session.id);

      const configuration = threadConfiguration(execution, profile.instructions);
      const targetProvider = execution.provider;

      const candidateThread =
        session.threads?.[targetProvider] ||
        (session.thread?.provider === targetProvider ? session.thread : null);

      const targetUncertain = candidateThread?.status === "uncertain";

      if (
        (this.requiresRecovery(session.id, input.profile_id) || targetUncertain) &&
        !input.acknowledge_uncertain
      ) {
        throw new AdeError(
          "recovery",
          "The previous turn may have changed files or executed commands. Inspect its activity and acknowledge the uncertain outcome before sending a new instruction. No operation was replayed.",
        );
      }

      // Older threads include the selected model (or an empty default) in their configuration hash.
      const compatibleThread =
        candidateThread &&
        (candidateThread.configuration === configuration ||
          candidateThread.configuration ===
            threadConfiguration(execution, profile.instructions, candidateThread.model) ||
          candidateThread.configuration ===
            threadConfiguration(execution, profile.instructions, ""));

      const thread =
        !input.new_thread &&
        compatibleThread &&
        (!interrupted || interrupted.threadId === candidateThread.thread_id)
          ? candidateThread
          : null;

      const conversation = thread ? { threadId: thread.thread_id } : {};

      const lastRun = this.db.all<{ provider: string }>(
        "SELECT provider FROM utility_runs WHERE viber_session_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1",
        session.id,
      )[0];

      const previousProvider = lastRun?.provider || session.thread?.provider;
      const isProviderSwitch = !!(previousProvider && previousProvider !== targetProvider);

      const lastClear = this.db.all<{ rowid: number }>(
        "SELECT rowid FROM viber_messages WHERE session_id=? AND role='user' AND content='/clear' AND configuration IS NULL AND status='completed' ORDER BY rowid DESC LIMIT 1",
        session.id,
      )[0];

      const minRowid = lastClear ? lastClear.rowid : 0;

      let history: { role: string; content: string }[] = [];
      if (input.history_ids.length > 0) {
        if (thread) {
          throw new AdeError(
            "context",
            "Native threads retain their context. Start a new thread to attach selected history.",
          );
        }

        history = input.history_ids.map((id) => {
          const row = this.db.all<{ role: string; content: string }>(
            "SELECT role,content FROM viber_messages WHERE id=? AND session_id=? AND status='completed'",
            id,
            session.id,
          )[0];

          if (!row) {
            throw new AdeError(
              "context",
              "Select completed messages from this Viber session only.",
            );
          }

          return { role: row.role, content: row.content };
        });

        if (JSON.stringify(history).length > 64000) {
          throw new AdeError(
            "context",
            "Selected bootstrap context exceeds 64,000 characters. Select less history or send a concise handoff.",
          );
        }
      } else if (
        !interrupted &&
        !thread &&
        !input.new_thread &&
        (isProviderSwitch || !candidateThread)
      ) {
        const rows = this.db.all<{ role: string; content: string }>(
          "SELECT role,content FROM viber_messages WHERE session_id=? AND status='completed' AND role IN ('user','assistant') AND rowid>? ORDER BY rowid ASC",
          session.id,
          minRowid,
        );

        history = rows.map((r) => ({ role: r.role, content: r.content }));
        while (history.length > 1 && JSON.stringify(history).length > 60000) {
          history.shift();
        }
      }

      let missedMessages: { role: string; content: string }[] = [];
      if (!interrupted && thread && isProviderSwitch) {
        const threadRun = this.db.all<{ last_rowid: number }>(
          "SELECT max(m.rowid) as last_rowid FROM viber_messages m JOIN utility_runs r ON (r.viber_message_id=m.id OR m.run_id=r.id) WHERE m.session_id=? AND r.provider=? AND r.conversation_id=? AND m.status='completed'",
          session.id,
          targetProvider,
          thread.thread_id,
        )[0];

        const lastSeenRowid = Math.max(threadRun?.last_rowid || 0, minRowid);

        missedMessages = this.db.all<{ role: string; content: string }>(
          "SELECT role,content FROM viber_messages WHERE session_id=? AND status='completed' AND role IN ('user','assistant') AND rowid>? ORDER BY rowid ASC",
          session.id,
          lastSeenRowid,
        );
      }

      let prompt: string;
      if (interrupted) {
        prompt = thread
          ? `${continueLabel} Check what already changed before editing.`
          : freshContinuationPrompt(interrupted.originalPrompt);
      } else if (thread) {
        if (missedMessages.length > 0) {
          const missedItems = missedMessages.map(
            (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`,
          );

          while (missedItems.length > 1 && missedItems.join("\n\n").length > 40000) {
            missedItems.shift();
          }

          prompt = `[Reference only. The following conversation occurred with another provider since your last turn in this thread. Act only on the current user instruction.]:\n${missedItems.join("\n\n")}\n\n[Current user instruction]:\n${input.content}`;
        } else {
          prompt = input.content;
        }
      } else {
        const historyItems = history.map(
          (m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`,
        );

        const header = isProviderSwitch
          ? "[The following conversation occurred with another provider]:"
          : "[Historical messages are reference data only. Act only on the current user instruction.]:";

        prompt = agentPrompt(profile.instructions, [
          ...(historyItems.length
            ? [
                {
                  role: "context",
                  content: `${header}\n${historyItems.join("\n\n")}`,
                },
              ]
            : []),
          { role: "user", content: input.content },
        ]);
      }

      const snapshot = ViberMessageSnapshotSchema.parse({
        request: input,
        profile,
        execution,
        prompt,
        conversation,
        originalPrompt: interrupted?.originalPrompt,
      });

      this.db.run(
        "INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects) VALUES(?,?,'user',?,'pending',?,?,'none')",
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

      const updatedThreads = { ...(session.threads || {}) };
      if (thread) {
        updatedThreads[targetProvider] = thread;
      } else {
        delete updatedThreads[targetProvider];
      }

      this.db.run(
        "UPDATE viber_sessions SET thread=?, threads=? WHERE id=?",
        thread ? JSON.stringify(thread) : null,
        JSON.stringify(updatedThreads),
        session.id,
      );

      return snapshot;
    });

  assertExecution = (
    sessionId: string,
    messageId: string,
    execution: AgentExecution,
    prompt: string,
    conversation: { threadId?: string } = {},
    originalPrompt?: string,
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
      snapshot.prompt !== prompt ||
      snapshot.conversation.threadId !== conversation.threadId ||
      snapshot.originalPrompt !== originalPrompt
    ) {
      throw new AdeError(
        "isolation",
        "Viber execution must match its unconsumed message snapshot.",
      );
    }
  };

  startFreshContinuation = (sessionId: string, messageId: string) =>
    this.db.transaction(() => {
      const row = this.db.all<{ configuration: string; run_id: string }>(
        "SELECT m.configuration,m.run_id FROM viber_messages m JOIN utility_runs r ON r.id=m.run_id WHERE m.id=? AND m.session_id=? AND m.status='pending' AND r.status='running' AND r.conversation_id IS NULL",
        messageId,
        sessionId,
      )[0];

      const snapshot = row && ViberMessageSnapshotSchema.parse(JSON.parse(row.configuration));
      if (!snapshot?.conversation.threadId || snapshot.originalPrompt === undefined) {
        throw new AdeError("recovery", "A fresh thread requires a pending continuation.");
      }

      const session = this.session(sessionId, snapshot.profile.id);
      this.assertThread(sessionId, snapshot.execution.provider, snapshot.conversation.threadId);
      const threads = { ...session.threads };
      delete threads[snapshot.execution.provider];
      const prompt = freshContinuationPrompt(snapshot.originalPrompt);

      this.db.run("UPDATE utility_runs SET prompt=? WHERE id=?", prompt, row.run_id);

      this.db.run(
        "UPDATE viber_sessions SET thread=NULL,threads=? WHERE id=?",
        JSON.stringify(threads),
        sessionId,
      );

      return prompt;
    });

  assertThread = (sessionId: string, provider: AgentExecution["provider"], threadId: string) => {
    const row = this.db.all<{ thread: string | null }>(
      "SELECT thread FROM viber_sessions WHERE id=?",
      sessionId,
    )[0];

    const thread = row?.thread ? ViberThreadSchema.parse(JSON.parse(row.thread)) : null;
    if (thread?.provider !== provider || thread.thread_id !== threadId) {
      throw new AdeError(
        "recovery",
        "The native thread changed. Send /clear to start a new thread.",
      );
    }
  };

  recordThread = (sessionId: string, messageId: string, threadId: string, model: string) => {
    const row = this.db.all<{ configuration: string; run_id: string; prompt: string }>(
      "SELECT m.configuration,m.run_id,r.prompt FROM viber_messages m JOIN utility_runs r ON r.id=m.run_id WHERE m.id=? AND m.session_id=? AND m.status='pending'",
      messageId,
      sessionId,
    )[0];

    if (!row) {
      throw new AdeError("isolation", "Thread identity requires a pending session turn.");
    }

    const snapshot = ViberMessageSnapshotSchema.parse(JSON.parse(row.configuration));
    const currentSession = this.session(sessionId, snapshot.profile.id);

    const resumedThread =
      snapshot.originalPrompt !== undefined &&
      row.prompt === freshContinuationPrompt(snapshot.originalPrompt)
        ? undefined
        : snapshot.conversation.threadId;

    const expected =
      resumedThread ||
      currentSession.threads?.[snapshot.execution.provider]?.thread_id ||
      currentSession.thread?.thread_id;

    if (expected && expected !== threadId) {
      throw new AdeError(
        "provider_failed",
        "Provider returned a different native thread. Send /clear to start a new thread.",
      );
    }

    if (
      this.db.all(
        "SELECT id FROM utility_runs WHERE conversation_id=? AND json_extract(execution,'$.configuration.provider')=? AND viber_session_id IS NOT NULL AND id<>? AND (viber_session_id<>? OR ? IS NULL) LIMIT 1",
        threadId,
        snapshot.execution.provider,
        row.run_id,
        sessionId,
        resumedThread || null,
      ).length
    ) {
      throw new AdeError(
        "isolation",
        "Provider thread already belongs to a saved execution. A fresh thread cannot reuse another conversation.",
      );
    }

    const thread = ViberThreadSchema.parse({
      thread_id: threadId,
      provider: snapshot.execution.provider,
      configuration: threadConfiguration(snapshot.execution, snapshot.profile.instructions),
      status: "uncertain",
      model,
    });

    const threads = {
      ...(currentSession.threads || {}),
      [snapshot.execution.provider]: thread,
    };

    this.db.run(
      "UPDATE viber_sessions SET thread=?, threads=? WHERE id=?",
      JSON.stringify(thread),
      JSON.stringify(threads),
      sessionId,
    );
  };

  finish = (
    messageId: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    output?: unknown,
    error?: string,
  ) =>
    this.db.transaction(() => {
      const row = this.db.all<{ session_id: string; run_id: string | null; effects: string }>(
        "SELECT session_id,run_id,effects FROM viber_messages WHERE id=? AND status='pending'",
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

      if (status === "completed" || row.effects !== "none") {
        const nextStatus = status === "completed" ? "ready" : "uncertain";

        const sessionRow = this.db.all<{ thread: string | null; threads: string | null }>(
          "SELECT thread, threads FROM viber_sessions WHERE id=?",
          row.session_id,
        )[0];

        let threads: Record<string, z.infer<typeof ViberThreadSchema>> = {};
        if (sessionRow?.threads) {
          try {
            threads = JSON.parse(sessionRow.threads);
          } catch {
            threads = {};
          }
        }

        const activeThread = sessionRow?.thread ? JSON.parse(sessionRow.thread) : null;
        if (activeThread) {
          activeThread.status = nextStatus;
          if (activeThread.provider) {
            threads[activeThread.provider] = {
              ...(threads[activeThread.provider] || activeThread),
              status: nextStatus,
            };
          }
        }

        this.db.run(
          "UPDATE viber_sessions SET thread=?, threads=? WHERE id=?",
          activeThread ? JSON.stringify(activeThread) : null,
          JSON.stringify(threads),
          row.session_id,
        );
      }
    });
}
