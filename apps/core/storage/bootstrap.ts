import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, realpath } from "node:fs/promises";

import { exists } from "../workspace/paths";
import { migrateDataRoot } from "./migrate-root";
import { AdeError } from "../domain";

export const dataRootChoice = async (home = homedir(), configured = process.env.VIBESTAR_HOME) => {
  const root = join(home, ".akkco-vibestar");
  if (configured) {
    if (await exists(join(configured, "runtime", "migration-pending.json"))) {
      const actual = await realpath(configured);

      const journal = JSON.parse(
        await readFile(join(actual, "runtime", "migration-pending.json"), "utf8"),
      );

      if (typeof journal.source !== "string" || journal.target !== actual) {
        throw new AdeError("migration", "Interrupted migration metadata could not be verified.");
      }

      throw new AdeError(
        "migration",
        "An interrupted migration needs recovery. Please resolve migration-pending.json before starting.",
      );
    }

    return { root: configured, migration: null };
  }

  if (await exists(join(root, "runtime", "migration-pending.json"))) {
    throw new AdeError(
      "migration",
      "An interrupted migration needs recovery. Please resolve migration-pending.json before starting.",
    );
  }

  return { root, migration: null };
};

export const chooseDataRoot = async (
  migration: { old_root: string; new_root: string },
  choice: "migrate" | "old" | "fresh",
) => {
  if (choice === "migrate") {
    return migrateDataRoot(migration.old_root, migration.new_root);
  }

  if (choice === "old") {
    await writeFile(join(migration.old_root, "state", "data-root-choice.json"), '"old"', {
      mode: 0o600,
    });

    return migration.old_root;
  }

  if (await exists(join(migration.new_root, "runtime", "migration-pending.json"))) {
    throw new AdeError(
      "migration",
      "An interrupted migration needs to be recovered. Choose Migrate to retry, or Use old location.",
    );
  }

  return migration.new_root;
};
