import type { Settings } from "../domain";
import type { Database } from "../storage/database";
import { memoryTextKey } from "./memory-evidence";
import type { localMemoryModels } from "./memory-local";

export interface MemoryTurnScope {
  profileId: string;
  sessionId: string;
  messageId: string;
  repositoryId: string | null;
  provider: "codex" | "antigravity";
}

export interface MemoryMatch {
  id: string;
  revision: number;
  text: string;
}

type Models = Pick<typeof localMemoryModels, "identify" | "embed">;

type SettingsReader = () => Settings["viber_memory"];

const normalize = (vector: number[]) => {
  const magnitude = Math.hypot(...vector);
  return magnitude > 0 && Number.isFinite(magnitude)
    ? vector.map((value) => value / magnitude)
    : null;
};

const encode = (vector: number[]) => {
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (const [index, value] of vector.entries()) {
    bytes.writeFloatLE(value, index * 4);
  }

  return bytes;
};

const decode = (raw: Buffer | null, dimensions: number) =>
  raw && dimensions >= 1 && dimensions <= 8192 && raw.length === dimensions * 4
    ? Float32Array.from({ length: dimensions }, (_, index) => raw.readFloatLE(index * 4))
    : null;

const similarity = (a: number[] | Float32Array, b: Float32Array | null) => {
  if (!b || a.length !== b.length) {
    return -1;
  }

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }

  return dot;
};

const embeddingInput = (model: string, text: string, query = false) =>
  model.split(":")[0] === "nomic-embed-text"
    ? `${query ? "search_query" : "search_document"}: ${text}`
    : text;

const topicDescription = (topic: string) =>
  `Topic: ${topic.replace(/\bDSA\b/gi, "data structures and algorithms (DSA)")}`;

export class ViberMemoryIndex {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsReader,
    private readonly models: Models,
  ) {}

  rebuild = async (signal: AbortSignal) => {
    const { recall, embedding_model: model } = this.settings();
    if (!recall || !model) {
      return;
    }

    const digest = await this.models.identify(model, signal);
    if (!digest || signal.aborted || this.settings().embedding_model !== model) {
      return;
    }

    this.db.run("DELETE FROM viber_memory_vectors WHERE model<>? OR digest<>?", model, digest);

    const rows = this.db.all<MemoryMatch & { profile_id: string; topic: string | null }>(
      `SELECT f.id,f.profile_id,f.text,d.revision,d.topic
       FROM viber_memory_details d JOIN viber_memory_facts f ON f.profile_id=d.profile_id AND f.id=d.fact_id
       LEFT JOIN viber_memory_vectors v ON v.profile_id=d.profile_id AND v.fact_id=d.fact_id AND v.revision=d.revision
       WHERE d.needs_review=0 AND (d.repository_id IS NOT NULL OR d.topic IS NOT NULL) AND v.fact_id IS NULL
         AND d.profile_id NOT IN (SELECT profile_id FROM retired_viber_profiles) ORDER BY f.rowid`,
    );

    for (const { profile_id, id, text, revision, topic } of rows) {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);

      const [vector, topicVector] = await this.models.embed(
        model,
        [text, ...(topic ? [topicDescription(topic)] : [])].map((value) =>
          embeddingInput(model, value),
        ),
        timeout,
      );

      const normalized = normalize(vector);
      const normalizedTopic = topicVector ? normalize(topicVector) : null;
      const current = this.settings();
      if (signal.aborted || !current.recall || current.embedding_model !== model) {
        return;
      }

      if (!normalized || (topic && normalizedTopic?.length !== normalized.length)) {
        continue;
      }

      if ((await this.models.identify(model, timeout)) !== digest || signal.aborted) {
        return;
      }

      this.db.run(
        `INSERT OR REPLACE INTO viber_memory_vectors SELECT profile_id,fact_id,revision,?,?,?,?,?
         FROM viber_memory_details WHERE profile_id=? AND fact_id=? AND revision=? AND needs_review=0`,
        model,
        digest,
        normalized.length,
        encode(normalized),
        normalizedTopic ? encode(normalizedTopic) : null,
        profile_id,
        id,
        revision,
      );
    }
  };

  search = async (scope: MemoryTurnScope, prompt: string, model: string, signal: AbortSignal) => {
    const digest = await this.models.identify(model, signal);
    if (!digest || signal.aborted) {
      return null;
    }

    const candidates = this.db.all<
      MemoryMatch & {
        dimensions: number;
        vector: Buffer;
        topic: string | null;
        topic_vector: Buffer | null;
      }
    >(
      `SELECT f.id,f.text,d.revision,d.topic,v.dimensions,v.vector,v.topic_vector
       FROM viber_memory_details d
       JOIN viber_memory_facts f ON f.profile_id=d.profile_id AND f.id=d.fact_id
       JOIN viber_memory_vectors v ON v.profile_id=d.profile_id AND v.fact_id=d.fact_id AND v.revision=d.revision
       WHERE d.profile_id=? AND (d.repository_id=? OR (d.repository_id IS NULL AND d.topic IS NOT NULL))
         AND d.needs_review=0 AND v.model=? AND v.digest=? ORDER BY f.rowid`,
      scope.profileId,
      scope.repositoryId,
      model,
      digest,
    );

    if (!candidates.length) {
      return { digest, matches: [] };
    }

    const [query] = await this.models.embed(model, [embeddingInput(model, prompt, true)], signal);
    const vector = normalize(query);
    if (!vector || signal.aborted) {
      return null;
    }

    const matches = candidates
      .filter(
        (row) => !row.topic || similarity(vector, decode(row.topic_vector, row.dimensions)) >= 0.45,
      )
      .map((row) => {
        const value = decode(row.vector, row.dimensions);
        return {
          id: row.id,
          revision: row.revision,
          text: row.text,
          value,
          score: similarity(vector, value),
        };
      })
      .filter((row) => row.score >= 0.55 && row.value !== null)
      .sort((a, b) => b.score - a.score);

    return { digest, matches };
  };
}

export const deduplicateMemory = <T extends MemoryMatch & { value: Float32Array | null }>(
  ranked: T[],
  state: (match: T) => "sent" | "available" | "unavailable",
) => {
  const candidates = ranked.map((match) => ({ match, state: state(match) }));
  const seen = candidates.filter((row) => row.state === "sent").map(({ match }) => match);
  const selected: T[] = [];
  for (const { match, state } of candidates) {
    if (state !== "available") {
      continue;
    }

    if (
      seen.some(
        (other) =>
          memoryTextKey(other.text) === memoryTextKey(match.text) ||
          similarity(match.value ?? [], other.value) >= 0.94,
      )
    ) {
      continue;
    }

    seen.push(match);
    selected.push(match);
    if (selected.length === 3) {
      break;
    }
  }

  return selected;
};
