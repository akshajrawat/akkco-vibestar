import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";

import { Database } from "../../apps/core/storage/database";
import { migrations } from "../../apps/core/storage/migrations";
import { viberSnapshotVersion } from "../../apps/core/storage/viber-snapshots";
import { viberProfile } from "../helpers/viber-fixtures";

it.each([0, viberSnapshotVersion, 47])(
  "upgrades a version-%i Viber database without losing existing facts",
  async (version) => {
    const dir = await mkdtemp(join(tmpdir(), "vibestar-memory-migration-"));
    const path = join(dir, "vibestar.sqlite");
    const timestamp = "2026-01-01T00:00:00.000Z";
    const fact = { id: randomUUID(), text: "A fact from the older database." };

    try {
      const old = new BetterSqlite3(path);
      try {
        old.transaction(() => {
          for (const migration of migrations.filter((migration) => migration.version <= version)) {
            old.exec(migration.sql);

            old
              .prepare("INSERT INTO schema_migrations VALUES(?,?)")
              .run(migration.version, timestamp);
          }

          old
            .prepare("INSERT INTO agent_profiles VALUES(?,1,?,?)")
            .run(viberProfile.id, timestamp, timestamp);

          old
            .prepare("INSERT INTO agent_profile_revisions VALUES(?,1,?,?)")
            .run(viberProfile.id, JSON.stringify(viberProfile), timestamp);

          if (version === 47) {
            old
              .prepare("INSERT INTO viber_memory_facts VALUES(?,?,?)")
              .run(viberProfile.id, fact.id, fact.text);
          }
        })();
      } finally {
        old.close();
      }

      const upgraded = await Database.open(path);
      try {
        expect(
          upgraded.all(
            "SELECT id,text FROM viber_memory_facts WHERE profile_id=?",
            viberProfile.id,
          ),
        ).toEqual(version === 47 ? [fact] : []);

        expect(upgraded.all("SELECT fact_id FROM viber_memory_vectors")).toEqual([]);
        expect(upgraded.all("PRAGMA foreign_key_check")).toEqual([]);
      } finally {
        upgraded.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
