import { gitCapture, gitChecked } from "./git-command";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { readdir, realpath, lstat } from "node:fs/promises";
import { AdeError, now, remoteIdentity } from "../domain";
import type { Database } from "../storage/database";
import { checked, redact } from "../execution/runtime/process";
import { inside } from "./paths";
import { z } from "zod";

export const LocalRepositoryInput = z
  .object({
    environment: z.enum(["wsl", "windows"]),
    path: z
      .string()
      .max(2000)
      .regex(/^[^\x00-\x1f]+$/)
      .trim()
      .min(1),
  })
  .strict();

export const ConnectLocalInput = z
  .object({
    verification_id: z.string().uuid(),
    upstream_remote: z.string().min(1).max(200),
    origin_remote: z.string().min(1).max(200).nullable(),
    base_branch: z.string().min(1).max(200),
  })
  .strict();

export interface VerifiedLocalRepository {
  verification_id: string;
  path: string;
  environment: "wsl" | "windows";
  distro: string;
  windows_path?: string;
  branch: string;
  dirty: boolean;
  remotes: {
    name: string;
    url: string;
    identity: string | null;
    default_branch: string | null;
  }[];
  branches: string[];
  upstream_remote: string | null;
  origin_remote: string | null;
  base_branch: string | null;
}

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

const localRepositorySchema = z
  .object({
    path: z.string(),
    origin: z.string().nullable(),
    upstream: z.string().nullable(),
    identities: z.array(z.string()),
    branch: z.string(),
    default_branch: z.string().nullable(),
    environment: z.enum(["wsl", "windows"]),
    indexed_at: z.string(),
  })
  .loose();

const indexMetadataSchema = z
  .object({
    last_scan: z.string().nullable().optional(),
    duration_ms: z.number().nonnegative().nullable().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict();

const ignored = new Set([
  "node_modules",
  ".git",
  ".cache",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
  "test-results",
  "playwright-report",
  "tmp",
  "temp",
  "tests",
  "__tests__",
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
  const path = value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value;
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
      repositories: this.db.records.list<LocalRepository>(
        "local_repositories",
        this.db.all<{ id: string; data: string }>(
          "SELECT path AS id,data FROM local_repositories ORDER BY path",
        ),
        localRepositorySchema.parse,
        "path",
      ),
      scanning: !!this.running,
      last_scan: null as string | null,
      duration_ms: null as number | null,
      warnings: [] as string[],
      ...(metadata
        ? this.db.records.tryDecode(
            {
              table: "settings",
              id: "repository_index",
              column: "value",
              source: metadata.value,
            },
            indexMetadataSchema.parse,
          ) || {}
        : {}),
    };
  };

  private resolveLocalPath = async (input: z.infer<typeof LocalRepositoryInput>) => {
    const p = LocalRepositoryInput.parse(input);
    let executionPath = p.path;
    if (p.environment === "windows") {
      if (!/^[a-z]:[\\/].+/i.test(p.path) || /^[a-z]:[\\/]+$/i.test(p.path))
        throw new AdeError(
          "invalid_input",
          "Enter a Windows repository path such as D:\\projects\\my-repo, not a drive root.",
        );
      executionPath = await checked("wslpath", ["-u", p.path], this.root);
      if (!isAbsolute(executionPath))
        throw new AdeError(
          "invalid_input",
          "Windows path conversion did not produce an absolute execution path.",
        );
    } else if (!p.path.startsWith("/") && !p.path.startsWith("~/")) {
      throw new AdeError("invalid_input", "Enter an absolute WSL path or a path starting with ~/.");
    }

    const path = await realpath(discoveryRoot(executionPath));
    if (discoveryRoot(path) !== path)
      throw new AdeError("invalid_input", "Invalid repository location.");
    return path;
  };

  locateLocal = async (input: z.infer<typeof LocalRepositoryInput>) => {
    const path = await this.resolveLocalPath(input);
    return this.db.repositories().find((repository) => repository.path === path) || null;
  };

  verifyLocal = async (input: z.infer<typeof LocalRepositoryInput>, allowManaged = false) => {
    const p = LocalRepositoryInput.parse(input);
    const path = await this.resolveLocalPath(p);
    const local = await this.inspect(path, undefined, allowManaged);
    if (local.path !== path)
      throw new AdeError("invalid_input", `Choose the repository root: ${local.path}`);
    const git = (args: string[]) => gitCapture(["-c", "core.fsmonitor=false", ...args], path);

    const status = await git([
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);

    if (status.code !== 0)
      throw new AdeError("git_verify", "Couldn't read repository status.", {
        details: status.stderr,
      });
    const names = await gitChecked(["remote"], path);

    const remotes = await Promise.all(
      names
        .split("\n")
        .filter(Boolean)
        .map(async (name) => {
          const [url, head] = await Promise.all([
            git(["remote", "get-url", name]),
            git(["symbolic-ref", "--short", `refs/remotes/${name}/HEAD`]),
          ]);

          const cleanUrl = indexedRemote(url.code === 0 ? url.stdout.trim() : null) || "";
          let identity: string | null = null;
          try {
            const r = remoteIdentity(cleanUrl);
            identity = `${r.owner}/${r.name}`;
          } catch {
            /* Non-GitHub remotes remain visible but cannot be an issue upstream. */
          }

          return {
            name,
            url: cleanUrl,
            identity,
            default_branch: head.code === 0 ? head.stdout.trim().slice(name.length + 1) : null,
          };
        }),
    );

    const refs = await gitChecked(
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
      path,
    );

    const branches = [
      ...new Set(
        refs
          .split("\n")
          .filter(Boolean)
          .filter((ref) => !ref.endsWith("/HEAD"))
          .map((ref) => ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "")),
      ),
    ];

    const github = remotes.filter((remote) => remote.identity);

    const upstream =
      github.find((remote) => remote.name === "upstream") ||
      (github.length === 1 ? github[0] : null);

    const origin = github.find(
      (remote) => remote.name === "origin" && remote.name !== upstream?.name,
    );

    return {
      ...local,
      environment: p.environment,
      distro: process.env.WSL_DISTRO_NAME || "Linux",
      ...(p.environment === "windows" ? { windows_path: p.path } : {}),
      dirty: !!status.stdout.trim(),
      remotes,
      branches,
      upstream_remote: upstream?.name || null,
      origin_remote: origin?.name || null,
      base_branch: upstream?.default_branch || null,
    };
  };

  inspect = async (
    path: string,
    signal?: AbortSignal,
    allowManaged = false,
  ): Promise<LocalRepository> => {
    const top = await realpath(await gitChecked(["rev-parse", "--show-toplevel"], path, signal));

    const common = await realpath(
      resolve(top, await gitChecked(["rev-parse", "--git-common-dir"], top, signal)),
    );

    if (
      !allowManaged &&
      (inside(this.root, top) ||
        top === this.root ||
        inside(this.root, common) ||
        common === this.root)
    )
      throw new AdeError("isolation", "Vibestar-managed directories cannot be imported.");

    const git = async (args: string[]) => {
      const result = await gitCapture(["-c", "core.fsmonitor=false", ...args], top, signal);
      return result.code === 0 ? result.stdout.trim() : null;
    };

    const [rawOrigin, rawUpstream, branch, defaultRef] = await Promise.all([
      git(["remote", "get-url", "origin"]),
      git(["remote", "get-url", "upstream"]),
      git(["branch", "--show-current"]),
      git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
    ]);

    const origin = indexedRemote(rawOrigin),
      upstream = indexedRemote(rawUpstream);

    const all = await git(["remote", "-v"]);

    const identities = [
      ...new Set(
        [origin, upstream, ...(all || "").split("\n").map((r) => r.split(/\s+/)[1])]
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
          Number(a.environment === "windows") - Number(b.environment === "windows") ||
          a.path.localeCompare(b.path),
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
        [
          ...settings.roots,
          ...this.db
            .repositories()
            .filter((r) => r.source === "imported")
            .map((r) => r.path),
          ...(settings.scan_home ? ["~"] : []),
        ].map((r) => discoveryRoot(r)),
      ),
    ];

    const visited = new Set<string>();
    const found = new Map<string, LocalRepository>();
    const warnings: string[] = [];
    let entries = 0;

    const visit = async (path: string, depth: number) => {
      signal.throwIfAborted();
      if (depth > settings.max_depth || entries >= 30000 || Date.now() - start > 60000) return;
      try {
        const actual = await realpath(path);
        if (visited.has(actual) || actual === this.root || inside(this.root, actual)) return;
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
            !/^vibestar-(?:chat-workspace|gate-desktop|pr-repair-desktop|.*-fixture)-/.test(
              row.name,
            ) &&
            !row.name.startsWith(".")
          )
            await visit(join(actual, row.name), depth + 1);
        }
      } catch (e) {
        signal.throwIfAborted();
        if (!["ENOENT", "EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code || ""))
          warnings.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    for (const root of roots) {
      signal.throwIfAborted();
      try {
        const actual = discoveryRoot(await realpath(root));
        if (!(await lstat(root)).isSymbolicLink()) await visit(actual, 0);
      } catch (e) {
        signal.throwIfAborted();
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${root}: ${String(e)}`);
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
