import { randomUUID } from "node:crypto";
import type { z } from "zod";

import { AdeError } from "../domain";
import type { Database } from "../storage/database";
import { viberMemoryFactLimit, viberMemoryInputs, type ViberMemoryFact } from "./memory-contracts";

export class ViberMemory {
  constructor(private readonly db: Database) {}

  list = (raw: unknown) => {
    const { profile_id } = this.scope(viberMemoryInputs["viber.memory.list"], raw);
    return this.db.all<ViberMemoryFact>(
      "SELECT id,text FROM viber_memory_facts WHERE profile_id=? ORDER BY rowid",
      profile_id,
    );
  };

  create = (raw: unknown) => {
    const { profile_id, text } = this.scope(viberMemoryInputs["viber.memory.create"], raw);
    const id = randomUUID();

    this.db.run(
      "INSERT INTO viber_memory_facts(profile_id,id,text) VALUES(?,?,?)",
      profile_id,
      id,
      text,
    );

    return { id, text };
  };

  update = (raw: unknown) => {
    const { profile_id, id, text } = this.scope(viberMemoryInputs["viber.memory.update"], raw);

    const result = this.db.run(
      "UPDATE viber_memory_facts SET text=? WHERE profile_id=? AND id=?",
      text,
      profile_id,
      id,
    );

    if (!result.changes) {
      throw new AdeError("not_found", "This fact could not be found in this Viber’s memory.");
    }

    return { id, text };
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

    return null;
  };

  private scope = <T extends { profile_id: string }>(schema: z.ZodType<T>, raw: unknown): T => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AdeError(
        "invalid_input",
        parsed.error.issues.some((issue) => issue.path[0] === "text")
          ? `Enter a fact between 1 and ${viberMemoryFactLimit} characters.`
          : "Select a valid Viber and, when editing or forgetting, a valid fact.",
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
