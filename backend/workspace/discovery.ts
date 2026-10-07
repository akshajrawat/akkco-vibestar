import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { readdir, realpath, lstat } from "node:fs/promises";
import { AdeError, now, remoteIdentity } from "../domain";
import type { Database } from "../storage/database";
import { capture, checked, redact } from "../execution/process";
import { inside } from "./paths";

export interface LocalRepository {
  path: string;
  origin: string | null;
  upstream: string | null;
  identities: string[];
  branch: string;
  default_branch: string | null;
  environment: "wsl" | "windows";
  indexed_at: string;
}
const ignored = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  "target",
  "vendor",
  ".akkco-ade",
  ".akkco-vibestar",
]);
const indexedRemote = (value: string | null) => {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol)) {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    /* SCP-style SSH remotes are normalized by remoteIdentity. */
  }
  return redact(value);
};
export interface RepositoryIndexSnapshot {
  repositories: LocalRepository[];
  scanning: boolean;
  last_scan: string | null;
  duration_ms: number | null;
  warnings: string[];
}
export const discoveryRoot = (value: string, home = homedir()) => {
  const path =
    value === "~"
      ? home
      : value.startsWith("~/")
        ? join(home, value.slice(2))
        : value;
  if (!isAbsolute(path))
    throw new AdeError(
      "invalid_input",
      "Repository search roots must be absolute or start with ~/.",
    );
  const root = resolve(path);
  if (
    ["/", "/home", "/mnt"].includes(root) ||
    /^\/mnt\/[a-z](?:\/Users)?\/?$/i.test(root) ||
    /^\/(?:proc|sys|dev|etc|usr|var|bin|sbin|run)(?:\/|$)/.test(root)
  )
    throw new AdeError(
      "invalid_input",
      "Choose a specific repository location. System roots and entire drives cannot be scanned.",
    );
  return root;
};
export class RepositoryIndex {
  private running: Promise<RepositoryIndexSnapshot> | undefined;
  private controller: AbortController | undefined;
  constructor(
    private readonly root: string,
    private readonly db: Database,
    private readonly onScan?: () => () => void,
  ) {}
  snapshot = (): RepositoryIndexSnapshot => {
    const metadata = this.db.all<{ value: string }>(
      "SELECT value FROM settings WHERE key='repository_index'",
    )[0];
    return {
      repositories: this.db
        .all<{ data: string }>(
          "SELECT data FROM local_repositories ORDER BY path",
        )
        .map((r) => JSON.parse(r.data) as LocalRepository),
      scanning: !!this.running,
      last_scan: null as string | null,
      duration_ms: null as number | null,
      warnings: [] as string[],
      ...(metadata ? JSON.parse(metadata.value) : {}),
    };
  };
  inspect = async (
    path: string,
    signal?: AbortSignal,
  ): Promise<LocalRepository> => {
    const top = await realpath(
      await checked("git", ["rev-parse", "--show-toplevel"], path, signal),
    );
    if (inside(this.root, top) || top === this.root)
      throw new AdeError(
        "isolation",
        "Vibestar-managed directories cannot be imported.",
      );
    const git = async (args: string[]) => {
      const result = await capture(
        "git",
        ["-c", "core.fsmonitor=false", ...args],
        top,
        signal,
      );
      return result.code === 0 ? result.stdout.trim() : null;
    };
    const [rawOrigin, rawUpstream, branch, defaultRef] = await Promise.all([
      git(["remote", "get-url", "origin"]),
      git(["remote", "get-url", "upstream"]),
      git(["symbolic-ref", "--short", "HEAD"]),
      git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    ]);
    const origin = indexedRemote(rawOrigin),
      upstream = indexedRemote(rawUpstream);
    const all = await git(["remote", "-v"]);
    const identities = [
      ...new Set(
        [
          origin,
          upstream,
          ...(all || "").split("\n").map((r) => r.split(/\s+/)[1]),
        ]
          .filter(Boolean)
          .flatMap((url) => {
            try {
              const r = remoteIdentity(indexedRemote(url!)!);
              return [`${r.owner}/${r.name}`.toLowerCase()];
            } catch {
              return [];
            }
          }),
      ),
    ];
    return {
      path: top,
      origin,
      upstream,
      identities,
      branch: branch || "detached",
      default_branch: defaultRef?.replace(/^origin\//, "") || null,
      environment: top.startsWith("/mnt/") ? "windows" : "wsl",
      indexed_at: now(),
    };
  };
  matches = (identity: string) =>
    this.snapshot()
      .repositories.filter((r) => r.identities.includes(identity.toLowerCase()))
      .sort(
        (a, b) =>
          Number(a.environment === "windows") -
            Number(b.environment === "windows") || a.path.localeCompare(b.path),
      );
  scan = () => {
    if (this.running) return this.running;
    const release = this.onScan?.();
    this.controller = new AbortController();
    this.running = this.performScan(this.controller.signal).then(
      () => {
        this.running = undefined;
        release?.();
        return this.snapshot();
      },
      (error) => {
        this.running = undefined;
        release?.();
        throw error;
      },
    );
    return this.running;
  };
  close = async () => {
    await this.stop();
  };
  stop = async () => {
    this.controller?.abort();
    await this.running?.catch(() => {});
  };
  private performScan = async (signal: AbortSignal) => {
    const start = Date.now();
    const settings = this.db.settings().repository_discovery;
    const roots = [
      ...new Set(
        [...settings.roots, ...(settings.scan_home ? ["~"] : [])].map((r) =>
          discoveryRoot(r),
        ),
      ),
    ];
    const visited = new Set<string>();
    const found = new Map<string, LocalRepository>();
    const warnings: string[] = [];
    let entries = 0;
    const visit = async (path: string, depth: number) => {
      signal.throwIfAborted();
      if (
        depth > settings.max_depth ||
        entries >= 30000 ||
        Date.now() - start > 60000
      )
        return;
      try {
        const actual = await realpath(path);
        if (
          visited.has(actual) ||
          actual === this.root ||
          inside(this.root, actual)
        )
          return;
        visited.add(actual);
        const rows = await readdir(actual, { withFileTypes: true });
        entries += rows.length;
        if (rows.some((r) => r.name === ".git")) {
          const repo = await this.inspect(actual, signal);
          found.set(repo.path, repo);
          return;
        }
        for (const row of rows) {
          if (
            row.isDirectory() &&
            !row.isSymbolicLink() &&
            !ignored.has(row.name) &&
            !row.name.startsWith(".")
          )
            await visit(join(actual, row.name), depth + 1);
        }
      } catch (e) {
        signal.throwIfAborted();
        if (
          !["ENOENT", "EACCES", "EPERM"].includes(
            (e as NodeJS.ErrnoException).code || "",
          )
        )
          warnings.push(
            `${path}: ${e instanceof Error ? e.message : String(e)}`,
          );
      }
    };
    for (const root of roots) {
      signal.throwIfAborted();
      try {
        const actual = discoveryRoot(await realpath(root));
        if (!(await lstat(root)).isSymbolicLink()) await visit(actual, 0);
      } catch (e) {
        signal.throwIfAborted();
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          warnings.push(`${root}: ${String(e)}`);
      }
    }
    if (entries >= 30000 || Date.now() - start > 60000)
      warnings.push(
        "Scan reached its safety limit. Add narrower search roots for complete coverage.",
      );
    const metadata = {
      last_scan: now(),
      duration_ms: Date.now() - start,
      warnings,
    };
    signal.throwIfAborted();
    this.db.transaction(() => {
      this.db.run("DELETE FROM local_repositories");
      for (const repo of found.values())
        this.db.run(
          "INSERT INTO local_repositories VALUES(?,?,?)",
          repo.path,
          JSON.stringify(repo),
          repo.indexed_at,
        );
      this.db.run(
        "INSERT INTO settings VALUES('repository_index',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify(metadata),
      );
    });
    return this.snapshot();
  };
}
