import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { now, type Settings } from "../domain";
import type { Database } from "../storage/database";
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
  storedMemorySubject,
  validateMemorySuggestion,
} from "./memory-evidence";

interface FactRow extends MemoryMatch {
  topic: string | null;
  subject: string | null;
  needs_review: number;
  source_at: string | null;
  source_order: number | null;
}

type SettingsValue = Settings["viber_memory"];

export class ViberMemory {
  private readonly index: ViberMemoryIndex;

  private readonly background = new Set<Promise<unknown>>();

  private readonly learning = new Map<string, Promise<void>>();

  private config = new AbortController();

  private indexPending = false;

  private indexing = false;

  private closed = false;

  constructor(private readonly db: Database) {
    this.index = new ViberMemoryIndex(db, this.settings, localMemoryModels);
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
        let skipped = new Set<string>();
        let retryDelay = 1000;
        try {
          while (this.indexPending && !this.closed) {
            this.indexPending = false;
            const config = this.config.signal;
            const budget = AbortSignal.timeout(120_000);
            const pass = { skipped, progress: false };
            await this.index.rebuild(AbortSignal.any([config, budget]), pass).catch(() => {});

            if (config.aborted || !budget.aborted) {
              skipped = new Set();
              retryDelay = 1000;
              continue;
            }

            this.indexPending = true;
            if (pass.progress) {
              retryDelay = 1000;
            } else {
              await delay(retryDelay, undefined, { signal: config, ref: false }).catch(() => {});
              retryDelay = Math.min(retryDelay * 2, 30_000);
              if (config.aborted) {
                skipped = new Set();
                retryDelay = 1000;
              }
            }
          }
        } finally {
          this.indexing = false;
        }
      }),
    );
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
          suggestions = await localMemoryModels.suggest(
            model,
            message,
            AbortSignal.any([config, AbortSignal.timeout(30_000)]),
          );
        }

        if (config.aborted || this.closed || !this.settings().automatic_saving) {
          return;
        }

        const saved = this.db.transaction(() => {
          const source = this.db.all<{ created_at: string; submission_order: number }>(
            `SELECT m.created_at,m.rowid AS submission_order FROM viber_messages m JOIN viber_sessions s ON s.id=m.session_id
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
              added = this.saveSuggestion(scope, source, suggestion) || added;
            }
          }

          return added;
        });

        if (saved) {
          this.queueIndex();
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
    source: { created_at: string; submission_order: number },
    suggestion: NonNullable<ReturnType<typeof validateMemorySuggestion>>,
  ) => {
    const topic = suggestion.topic && memoryTextKey(suggestion.topic);

    const current = this.db
      .all<FactRow>(
        `SELECT f.id,f.text,d.topic,d.revision,d.subject,d.needs_review,d.source_at,m.rowid AS source_order
         FROM viber_memory_facts f JOIN viber_memory_details d ON d.profile_id=f.profile_id AND d.fact_id=f.id
         LEFT JOIN viber_messages m ON m.id=d.source_message_id
         WHERE f.profile_id=? AND d.repository_id IS ? ORDER BY f.rowid`,
        scope.profileId,
        scope.repositoryId,
      )
      .filter((row) => (row.topic && memoryTextKey(row.topic)) === topic);

    const related = suggestion.subject
      ? current.filter(
          (row) => storedMemorySubject(row.text, row.subject, row.topic) === suggestion.subject,
        )
      : [];

    const duplicate =
      current.find((row) => memoryTextKey(row.text) === memoryTextKey(suggestion.text)) ??
      (suggestion.subject ? related : current).find(
        (row) => memoryValue(row.text) === suggestion.value,
      );

    const newer = (row: FactRow) =>
      row.source_order === null
        ? row.source_at !== null && row.source_at > source.created_at
        : row.source_order > source.submission_order;

    if ((duplicate && newer(duplicate)) || related.some(newer)) {
      return false;
    }

    if (duplicate && (!suggestion.correction || !duplicate.needs_review)) {
      this.db.run(
        `UPDATE viber_memory_details SET source_message_id=?,source_session_id=?,source_at=?,evidence=?
         WHERE profile_id=? AND fact_id=?`,
        scope.messageId,
        scope.sessionId,
        source.created_at,
        suggestion.evidence,
        scope.profileId,
        duplicate.id,
      );

      return false;
    }

    const replacement = suggestion.correction
      ? (duplicate ?? related.find((row) => !row.needs_review) ?? related[0])
      : undefined;

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

    for (const row of related) {
      if (row.id !== id && !row.needs_review) {
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
      source.created_at,
      suggestion.evidence,
      suggestion.subject,
      Number(review),
    );

    return true;
  };
}
