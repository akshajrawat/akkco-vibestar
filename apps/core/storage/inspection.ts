import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { now } from "../domain";
import type { Engine } from "../execution/engine";

const directorySize = async (path: string): Promise<number> => {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return entry.size;
    if (!entry.isDirectory()) return entry.size;
    let size = 0;
    for (const name of await readdir(path)) size += await directorySize(join(path, name));
    return size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
};

/** Reports owned storage without changing files or persisted records. */
export const inspectStorage = async (engine: Engine) => {
  const names = [
    "state",
    "repos",
    "worktrees",
    "workspaces",
    "logs",
    "artifacts",
    "cache",
    "runtime",
    "telemetry",
  ];

  const sizes = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await directorySize(join(engine.root, name))] as const),
    ),
  );

  return {
    root: engine.root,
    sizes,
    database:
      (await directorySize(join(engine.root, "state", "vibestar.sqlite"))) +
      (await directorySize(join(engine.root, "state", "vibestar.sqlite-wal"))) +
      (await directorySize(join(engine.root, "state", "vibestar.sqlite-shm"))),
    total: Object.values(sizes).reduce((n, value) => n + value, 0),
    measured_at: now(),
    external_repositories: engine.db
      .repositories()
      .filter((repository) => repository.source === "imported").length,
    flows: Object.fromEntries(
      [
        "agent_profiles",
        "flow_definitions",
        "flow_revisions",
        "flow_runs",
        "flow_run_invalidations",
        "flow_node_attempts",
        "flow_task_migrations",
        "flow_migration_sources",
      ].map((table) => [
        table,
        engine.db.all<{ count: number }>(`SELECT count(*) count FROM ${table}`)[0].count,
      ]),
    ),
  };
};
