import { randomUUID } from "node:crypto";
import type { z } from "zod";

import { AdeError, now, type Settings } from "../domain";
import type { Database } from "../storage/database";
import { viberMemoryFactLimit, viberMemoryInputs, type ViberMemoryFact } from "./memory-contracts";
import {
  ViberMemoryIndex,
  deduplicateMemory,
  type MemoryMatch,
  type MemoryTurnScope,
} from "./memory-index";
import { localMemoryModels } from "./memory-local";
import {
  canExtractMemory,
  memoryTextKey,
  memoryValue,
  validateMemorySuggestion,
} from "./memory-evidence";

interface FactRow extends MemoryMatch {
  repository_id: string | null;
  topic: string | null;
  source_message_id: string | null;
  source_session_id: string | null;
  source_at: string | null;
  evidence: string | null;
  subject: string | null;
  needs_review: number;
}

type SettingsValue = Settings["viber_memory"];

const factsSql = `SELECT f.id,f.text,d.repository_id,d.topic,COALESCE(d.revision,1) AS revision,
  d.source_message_id,d.source_session_id,d.source_at,d.evidence,d.subject,d.needs_review
  FROM viber_memory_facts f LEFT JOIN viber_memory_details d ON d.profile_id=f.profile_id AND d.fact_id=f.id`;

export class ViberMemory {
  private readonly index: ViberMemoryIndex;

  private readonly background = new Set<Promise<unknown>>();

  private readonly learning = new Map<string, Promise<void>>();

  private config = new AbortController();

  private indexPending = false;

  private indexing = false;

  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly changed: () => void = () => {},
    private readonly models = localMemoryModels,
  ) {
    this.index = new ViberMemoryIndex(db, this.settings, models);
  }

  private settings = () => this.db.displaySettings().viber_memory;

  private track = (work: Promise<unknown>) => {
    this.background.add(work);
    void work.finally(() => this.background.delete(work)).catch(() => {});
  };

  close = async () => {
    this.closed = true;
    this.config.abort();
    await Promise.allSettled(this.background);
  };

  reconfigure = (before: SettingsValue, after: SettingsValue) => {
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return;
    }

    this.config.abort();
    this.config = new AbortController();
    if (before.embedding_model !== after.embedding_model) {
      this.db.run("DELETE FROM viber_memory_vectors");
    }

    this.queueIndex();
  };

  queueIndex = () => {
    if (this.closed || !this.settings().recall) {
      return;
    }

    this.indexPending = true;
    if (this.indexing) {
      return;
    }

    this.indexing = true;

    this.track(
      Promise.resolve().then(async () => {
        try {
          while (this.indexPending && !this.closed) {
            this.indexPending = false;
            const signal = AbortSignal.any([this.config.signal, AbortSignal.timeout(120_000)]);
            await this.index.rebuild(signal).catch(() => {});
          }
        } finally {
          this.indexing = false;
        }
      }),
    );
  };

  private present = (profileId: string, fact: FactRow): ViberMemoryFact => {
    const shared = this.db.all<{ provider: "codex" | "antigravity"; at: string; revision: number }>(
      `SELECT provider,sent_at AS at,revision FROM viber_memory_shares
       WHERE profile_id=? AND fact_id=? ORDER BY sent_at DESC`,
      profileId,
      fact.id,
    );

    const repo =
      fact.repository_id && this.db.repositories().find(({ id }) => id === fact.repository_id);

    return {
      id: fact.id,
      text: fact.text,
      ...(fact.repository_id ? { repository_id: fact.repository_id } : {}),
      ...(repo ? { repository_label: `${repo.owner}/${repo.name}` } : {}),
      ...(fact.topic ? { topic: fact.topic } : {}),
      ...(fact.needs_review ? { needs_review: true } : {}),
      ...(fact.source_message_id && fact.source_session_id && fact.source_at && fact.evidence
        ? {
            source: {
              message_id: fact.source_message_id,
              session_id: fact.source_session_id,
              created_at: fact.source_at,
              evidence: fact.evidence,
            },
          }
        : {}),
      ...(shared.length
        ? {
            shared: shared
              .filter(
                (row, index) =>
                  shared.findIndex(
                    (item) =>
                      item.provider === row.provider &&
                      (item.revision === fact.revision) === (row.revision === fact.revision),
                  ) === index,
              )
              .map(({ provider, at, revision }) => ({
                provider,
                at,
                earlier_revision: revision !== fact.revision,
              })),
          }
        : {}),
    };
  };

  list = (raw: unknown) => {
    const { profile_id } = this.scope(viberMemoryInputs["viber.memory.list"], raw);
    return this.db
      .all<FactRow>(`${factsSql} WHERE f.profile_id=? ORDER BY f.rowid`, profile_id)
      .map((row) => this.present(profile_id, row));
  };

  create = (raw: unknown) => {
    const { profile_id, text, repository_id, topic } = this.scope(
      viberMemoryInputs["viber.memory.create"],
      raw,
    );

    const id = randomUUID();
    this.checkRepository(repository_id);

    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO viber_memory_facts(profile_id,id,text) VALUES(?,?,?)",
        profile_id,
        id,
        text,
      );

      if (repository_id || topic) {
        this.db.run(
          "INSERT INTO viber_memory_details(profile_id,fact_id,repository_id,topic) VALUES(?,?,?,?)",
          profile_id,
          id,
          repository_id ?? null,
          topic ?? null,
        );
      }
    });

    this.mutated();
    return this.present(profile_id, this.fact(profile_id, id));
  };

  update = (raw: unknown) => {
    const { profile_id, id, text, repository_id, topic } = this.scope(
      viberMemoryInputs["viber.memory.update"],
      raw,
    );

    this.checkRepository(repository_id);

    this.db.transaction(() => {
      const previous = this.fact(profile_id, id);

      this.db.run(
        "UPDATE viber_memory_facts SET text=? WHERE profile_id=? AND id=?",
        text,
        profile_id,
        id,
      );

      this.db.run(
        `INSERT INTO viber_memory_details(profile_id,fact_id,repository_id,topic,revision) VALUES(?,?,?,?,?)
         ON CONFLICT(profile_id,fact_id) DO UPDATE SET repository_id=excluded.repository_id,
         topic=excluded.topic,revision=excluded.revision,needs_review=0`,
        profile_id,
        id,
        repository_id === undefined ? previous.repository_id : repository_id,
        topic === undefined ? previous.topic : topic,
        previous.revision + 1,
      );

      this.db.run(
        "DELETE FROM viber_memory_vectors WHERE profile_id=? AND fact_id=?",
        profile_id,
        id,
      );
    });

    this.mutated();
    return this.present(profile_id, this.fact(profile_id, id));
  };

  forget = (raw: unknown) => {
    const { profile_id, id } = this.scope(viberMemoryInputs["viber.memory.forget"], raw);

    const result = this.db.run(
      "DELETE FROM viber_memory_facts WHERE profile_id=? AND id=?",
      profile_id,
      id,
    );

    if (!result.changes) {
      throw new AdeError("not_found", "This fact could not be found in this Viber’s memory.");
    }

    this.changed();
    return null;
  };

  private checkRepository = (id?: string | null) => {
    if (id) {
      this.db.repository(id);
    }
  };

  private fact = (profileId: string, id: string) => {
    const row = this.db.all<FactRow>(
      `${factsSql} WHERE f.profile_id=? AND f.id=?`,
      profileId,
      id,
    )[0];

    if (!row) {
      throw new AdeError("not_found", "This fact could not be found in this Viber’s memory.");
    }

    return row;
  };

  private mutated = () => {
    this.changed();
    this.queueIndex();
  };

  private mayRecall = (scope: MemoryTurnScope, model: string) => {
    const settings = this.settings();
    return (
      !this.closed &&
      settings.recall &&
      settings.share_with[scope.provider] &&
      settings.embedding_model === model
    );
  };

  prepareRecall = async (scope: MemoryTurnScope, prompt: string, signal: AbortSignal) => {
    const { embedding_model: model } = this.settings();
    if (!this.mayRecall(scope, model) || !model) {
      return undefined;
    }

    const config = this.config.signal;

    const result = await this.index
      .search(scope, prompt, model, AbortSignal.any([signal, config, AbortSignal.timeout(1500)]))
      .catch(() => null);

    if (!result?.matches.length) {
      this.queueIndex();
      return undefined;
    }

    return (threadId?: string) => {
      if (signal.aborted || config.aborted || !this.mayRecall(scope, model)) {
        return [];
      }

      const current = this.db.all<{ fact_id: string; revision: number; sent: number }>(
        `SELECT d.fact_id,d.revision,EXISTS (
           SELECT 1 FROM viber_memory_shares a WHERE a.profile_id=d.profile_id AND a.fact_id=d.fact_id
             AND a.revision=d.revision AND a.session_id=s.id AND a.provider=? AND a.thread_id=? AND a.in_context=1
         ) AS sent FROM viber_memory_details d
         JOIN viber_memory_vectors v ON v.profile_id=d.profile_id AND v.fact_id=d.fact_id AND v.revision=d.revision
         JOIN viber_sessions s ON s.id=? AND s.profile_id=d.profile_id AND s.repository_id IS ?
         WHERE d.profile_id=? AND (d.repository_id=? OR (d.repository_id IS NULL AND d.topic IS NOT NULL)) AND d.needs_review=0
           AND d.profile_id NOT IN (SELECT profile_id FROM retired_viber_profiles)
           AND v.model=? AND v.digest=?`,
        scope.provider,
        threadId ?? null,
        scope.sessionId,
        scope.repositoryId,
        scope.profileId,
        scope.repositoryId,
        model,
        result.digest,
      );

      const available = new Map(current.map((row) => [row.fact_id, row]));
      return deduplicateMemory(result.matches, ({ id, revision }) => {
        const row = available.get(id);
        if (row?.revision !== revision) {
          return "unavailable";
        }

        return row.sent ? "sent" : "available";
      });
    };
  };

  recordShares = (scope: MemoryTurnScope, threadId: string, facts: MemoryMatch[]) => {
    if (!facts.length) {
      return;
    }

    this.db.transaction(() => {
      for (const { id, revision } of facts) {
        this.db.run(
          `INSERT INTO viber_memory_shares(profile_id,fact_id,revision,session_id,provider,thread_id,sent_at)
           SELECT profile_id,id,?,?,?,?,? FROM viber_memory_facts WHERE profile_id=? AND id=?
           ON CONFLICT(profile_id,fact_id,revision,session_id,provider,thread_id)
           DO UPDATE SET in_context=1,sent_at=excluded.sent_at`,
          revision,
          scope.sessionId,
          scope.provider,
          threadId,
          now(),
          scope.profileId,
          id,
        );
      }
    });
  };

  compact = (scope: MemoryTurnScope, threadId: string) => {
    this.db.run(
      "UPDATE viber_memory_shares SET in_context=0 WHERE session_id=? AND provider=? AND thread_id=?",
      scope.sessionId,
      scope.provider,
      threadId,
    );
  };

  wasPrivateThread = (scope: MemoryTurnScope, threadId: string) =>
    this.db.all(
      `SELECT 1 FROM utility_runs r JOIN viber_memory_private_runs p ON p.run_id=r.id
     WHERE r.viber_session_id=? AND r.provider=? AND r.conversation_id=? LIMIT 1`,
      scope.sessionId,
      scope.provider,
      threadId,
    ).length > 0;

  markPrivateRun = (runId: string) => {
    this.db.run("INSERT OR IGNORE INTO viber_memory_private_runs(run_id) VALUES(?)", runId);
  };

  suggestionSignal = (message: string) =>
    !this.closed && this.settings().automatic_saving && canExtractMemory(message)
      ? this.config.signal
      : undefined;

  learn = (
    scope: MemoryTurnScope,
    message: string,
    providerSuggestions: unknown[],
    config: AbortSignal,
  ) => {
    const previous = this.learning.get(scope.profileId) ?? Promise.resolve();

    const work = previous
      .then(async () => {
        if (config.aborted || this.closed || !this.settings().automatic_saving) {
          return;
        }

        const model = this.settings().suggestion_model;
        let suggestions = providerSuggestions;
        if (!suggestions.length && model) {
          suggestions = await this.models.suggest(
            model,
            message,
            AbortSignal.any([config, AbortSignal.timeout(30_000)]),
          );
        }

        if (config.aborted || this.closed || !this.settings().automatic_saving) {
          return;
        }

        const saved = this.db.transaction(() => {
          const source = this.db.all<{ created_at: string }>(
            `SELECT m.created_at FROM viber_messages m JOIN viber_sessions s ON s.id=m.session_id
           WHERE m.id=? AND m.session_id=? AND s.profile_id=? AND s.repository_id IS ? AND m.content=?
             AND m.role='user' AND m.status='completed' AND s.profile_id NOT IN (SELECT profile_id FROM retired_viber_profiles)`,
            scope.messageId,
            scope.sessionId,
            scope.profileId,
            scope.repositoryId,
            message,
          )[0];

          if (!source) {
            return false;
          }

          let added = false;
          for (const raw of suggestions.slice(0, 3)) {
            const suggestion = validateMemorySuggestion(message, raw);
            if (suggestion) {
              added = this.saveSuggestion(scope, source.created_at, suggestion) || added;
            }
          }

          return added;
        });

        if (saved) {
          this.mutated();
        }
      })
      .catch(() => {});

    this.learning.set(scope.profileId, work);

    this.track(
      work.finally(() => {
        if (this.learning.get(scope.profileId) === work) {
          this.learning.delete(scope.profileId);
        }
      }),
    );
  };

  private saveSuggestion = (
    scope: MemoryTurnScope,
    timestamp: string,
    suggestion: NonNullable<ReturnType<typeof validateMemorySuggestion>>,
  ) => {
    const topic = suggestion.topic && memoryTextKey(suggestion.topic);

    const current = this.db
      .all<FactRow>(
        `${factsSql} WHERE f.profile_id=? AND d.repository_id IS ?`,
        scope.profileId,
        scope.repositoryId,
      )
      .filter((row) => (row.topic && memoryTextKey(row.topic)) === topic);

    if (current.some((row) => memoryTextKey(row.text) === memoryTextKey(suggestion.text))) {
      return false;
    }

    const related = suggestion.subject
      ? current.filter((row) => row.subject === suggestion.subject)
      : [];

    if (related.some((row) => memoryValue(row.text) === suggestion.value)) {
      return false;
    }

    const replacement = suggestion.correction && related.length === 1 ? related[0] : undefined;
    const id = replacement?.id ?? randomUUID();
    const review = !replacement && related.length > 0;
    if (replacement) {
      this.db.run(
        "UPDATE viber_memory_facts SET text=? WHERE profile_id=? AND id=?",
        suggestion.text,
        scope.profileId,
        id,
      );

      this.db.run(
        "DELETE FROM viber_memory_vectors WHERE profile_id=? AND fact_id=?",
        scope.profileId,
        id,
      );
    } else {
      this.db.run(
        "INSERT INTO viber_memory_facts(profile_id,id,text) VALUES(?,?,?)",
        scope.profileId,
        id,
        suggestion.text,
      );
    }

    if (review) {
      for (const row of related) {
        this.db.run(
          "UPDATE viber_memory_details SET needs_review=1 WHERE profile_id=? AND fact_id=?",
          scope.profileId,
          row.id,
        );

        this.db.run(
          "DELETE FROM viber_memory_vectors WHERE profile_id=? AND fact_id=?",
          scope.profileId,
          row.id,
        );
      }
    }

    this.db.run(
      `INSERT INTO viber_memory_details(profile_id,fact_id,repository_id,topic,revision,source_message_id,source_session_id,source_at,evidence,subject,needs_review)
       VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,fact_id) DO UPDATE SET
       revision=excluded.revision,source_message_id=excluded.source_message_id,source_session_id=excluded.source_session_id,
       source_at=excluded.source_at,evidence=excluded.evidence,subject=excluded.subject,needs_review=0`,
      scope.profileId,
      id,
      scope.repositoryId,
      suggestion.topic,
      (replacement?.revision ?? 0) + 1,
      scope.messageId,
      scope.sessionId,
      timestamp,
      suggestion.evidence,
      suggestion.subject,
      Number(review),
    );

    return true;
  };

  private scope = <T extends { profile_id: string }>(schema: z.ZodType<T>, raw: unknown): T => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AdeError(
        "invalid_input",
        parsed.error.issues.some((issue) => issue.path[0] === "text")
          ? `Enter a fact between 1 and ${viberMemoryFactLimit} characters.`
          : "Select a valid Viber, fact, repository or topic.",
      );
    }

    if (
      !this.db.all(
        "SELECT id FROM agent_profiles WHERE id=? AND id NOT IN (SELECT profile_id FROM retired_viber_profiles)",
        parsed.data.profile_id,
      ).length
    ) {
      throw new AdeError("not_found", "This Viber is no longer available.");
    }

    return parsed.data;
  };
}
