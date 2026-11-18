import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../execution/runtime/process";
import { z } from "zod";
import { AdeError, now } from "../domain";
import type { Engine } from "../execution/engine";
import { GitHubClient } from "./client";
import { type GitHubRepository, type GitHubPullRequest, type GitHubStatus } from "./contracts";

const watchSchema = z.object({
  auto_watch: z.boolean(),
  interval_minutes: z.number().int().min(5).max(10080),
  verify_codex: z.boolean(),
});

export interface CloneActivity {
  id: string;
  repository: string;
  repository_id?: string;
  destination?: string;
  upstream?: string;
  origin?: string | null;
  status: "resolving" | "cloning" | "completed" | "cancelled" | "failed";
  phase: string;
  percent?: number;
  error?: string;
  started_at: string;
}

export class GitHubService {
  private clones = new Map<
    string,
    {
      activity: CloneActivity;
      controller: AbortController;
      promise: Promise<void>;
    }
  >();

  cloneActivities = () => [...this.clones.values()].map((c) => c.activity);

  cancelClone = async (id: string) => {
    const clone = this.clones.get(id);
    if (!clone) {
      throw new AdeError("not_found", "Clone activity not found.");
    }

    clone.controller.abort();
    await clone.promise;
  };

  startClone = (name: string) => {
    this.engine.assertAvailable();
    if (
      [...this.clones.values()].some(
        (c) =>
          c.activity.repository.toLowerCase() === name.toLowerCase() &&
          ["resolving", "cloning"].includes(c.activity.status),
      )
    ) {
      throw new AdeError("busy", "This repository is already being cloned.");
    }

    const id = randomUUID();
    const controller = new AbortController();

    const activity: CloneActivity = {
      id,
      repository: name,
      status: "resolving",
      phase: "Resolving repository…",
      started_at: now(),
    };

    let repositoryId = "";
    let release = () => {};

    const promise = Promise.resolve()
      .then(async () => {
        const log = await open(join(this.engine.root, "logs", `clone-${id}.log`), "a", 0o600);
        let writes = Promise.resolve();

        const progress = (line: string) => {
          const safe = redact(line.replace(/\x1b\[[0-9;]*m/g, ""));

          writes = writes.then(async () => {
            await log.write(safe + "\n");
          });

          const percent = safe.match(
            /(?:Receiving objects|Resolving deltas|Counting objects|Compressing objects):\s*(\d+)%/,
          );

          activity.phase = safe.slice(0, 500) || activity.phase;
          activity.percent = percent ? Number(percent[1]) : undefined;
          this.engine.changed();
        };

        try {
          const repo = await this.useLocally(name, true, undefined, true, controller.signal);
          repositoryId = repo.id;
          repo.connected = false;
          repo.clone_status = "cloning";
          this.engine.db.saveRepository(repo);

          Object.assign(activity, {
            repository_id: repo.id,
            destination: repo.path,
            upstream: `${repo.owner}/${repo.name}`,
            origin: repo.origin_url,
            status: "cloning",
          });

          progress(
            `Cloning upstream ${repo.owner}/${repo.name}; origin ${repo.origin_url || "not configured"}`,
          );

          await this.engine.prepareClone(repo, controller.signal, undefined, progress);
          if (controller.signal.aborted) {
            throw new AdeError("cancelled", "Clone cancelled");
          }

          repo.connected = true;
          this.engine.db.saveRepository(repo);
          activity.status = "completed";
          activity.phase = "Ready";
          activity.percent = 100;
        } catch (error) {
          activity.status = controller.signal.aborted ? "cancelled" : "failed";
          activity.error = redact(error instanceof Error ? error.message : String(error));

          activity.phase = controller.signal.aborted
            ? "Clone cancelled · incomplete managed checkout removed"
            : "Clone failed";

          if (
            repositoryId &&
            !this.engine.db.all("SELECT id FROM viber_sessions WHERE repository_id=?", repositoryId)
              .length
          ) {
            this.engine.db.run("DELETE FROM repositories WHERE id=?", repositoryId);
          }
        } finally {
          try {
            await writes;
          } finally {
            await log.close();
            release();
            this.engine.changed();
          }
        }
      })
      .catch((error) => {
        activity.status = "failed";
        activity.error = String(error);
        release();
        this.engine.changed();
      });

    release = this.engine.trackActivity(
      {
        id: `clone:${id}`,
        kind: "repository",
        label: `Cloning ${name}`,
        stoppable: true,
      },
      () => this.cancelClone(id),
    );

    this.clones.set(id, { activity, controller, promise });
    for (const [key, clone] of this.clones) {
      if (this.clones.size > 20 && !["resolving", "cloning"].includes(clone.activity.status)) {
        this.clones.delete(key);
      }
    }

    this.engine.changed();
    return activity;
  };

  private controller = new AbortController();

  private running: Promise<ReturnType<GitHubService["snapshot"]>> | undefined;

  private status: GitHubStatus | null = null;

  private lastSync: string | null = null;

  private syncingCatalog = false;

  private error: string | null = null;

  private phase: string | null = null;

  private stopping = false;

  private closed = false;

  readonly client: GitHubClient;

  constructor(private readonly engine: Engine) {
    this.client = new GitHubClient(engine.root);

    const saved = engine.db.all<{ value: string }>(
      "SELECT value FROM settings WHERE key='github_sync'",
    )[0];

    const metadata =
      saved &&
      engine.db.records.tryDecode(
        {
          table: "settings",
          id: "github_sync",
          column: "value",
          source: saved.value,
        },
        z.object({
          last_sync: z.string().nullable(),
          error: z.string().nullable(),
          detail_cursor: z.number().int().nonnegative().optional(),
          known_cursor: z.number().int().nonnegative().optional(),
        }).parse,
      );

    this.lastSync = metadata?.last_sync || null;
    this.error = metadata?.error || null;
  }

  catalog = () => [] as GitHubRepository[];

  prs = () => [] as GitHubPullRequest[];

  settings = () => {
    const row = this.engine.db.all<{ value: string }>(
      "SELECT value FROM settings WHERE key='github_watch'",
    )[0];

    const saved = (row &&
      this.engine.db.records.tryDecode(
        {
          table: "settings",
          id: "github_watch",
          column: "value",
          source: row.value,
        },
        watchSchema.parse,
      )) || { auto_watch: false, interval_minutes: 60, verify_codex: false };

    return { ...saved, auto_watch: false, verify_codex: false };
  };

  configure = (input: unknown) => {
    const value = watchSchema.parse(input);
    if (value.auto_watch || value.verify_codex) {
      throw new AdeError(
        "manual_policy",
        "PR inspection and analysis require an explicit user action. Automatic watching and second-model verification are disabled.",
      );
    }

    this.engine.db.run(
      "INSERT INTO settings VALUES('github_watch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(value),
    );

    this.engine.changed();
    return value;
  };

  snapshot = () => ({
    clones: this.cloneActivities(),
    status: this.status,
    last_sync: this.lastSync,
    error: this.error,
    phase: this.phase,
    settings: this.settings(),
    repositories: this.catalog(),
    pull_requests: this.prs(),
  });

  resolve = async (name: string, signal = this.controller.signal) => {
    const repository = await this.client.repository(name, signal);
    let fork: GitHubRepository | undefined;
    const status = this.status || (await this.client.detect(signal));
    if (status.connected && repository.permissions?.push !== true) {
      const candidates = this.catalog().filter(
        (r) => r.fork && r.owner.login === status.username && r.name === repository.name,
      );

      for (const candidate of candidates) {
        const info = await this.client.repository(candidate.full_name, signal);
        if (info.parent?.full_name.toLowerCase() === repository.full_name.toLowerCase()) {
          fork = info;
          break;
        }
      }

      // A direct lookup handles a new fork not present in the last catalog sync.
      if (!fork && repository.owner.login !== status.username) {
        try {
          const info = await this.client.repository(
            `${status.username}/${repository.name}`,
            signal,
          );

          if (
            info.fork &&
            info.parent?.full_name.toLowerCase() === repository.full_name.toLowerCase()
          ) {
            fork = info;
          }
        } catch {
          /* A fork is optional; absence never guesses a relationship. */
        }
      }
    }

    return {
      repository,
      upstream_url: repository.clone_url,
      origin_url: fork?.clone_url || null,
      base_branch: repository.default_branch,
    };
  };

  useLocally = async (
    name: string,
    deferred = false,
    localPath?: string,
    managed = false,
    signal = this.controller.signal,
  ) => {
    let metadata = await this.client.repository(name, signal);
    const selectedFork = metadata.fork && metadata.parent ? metadata.clone_url : null;
    if (metadata.fork && metadata.parent) {
      metadata = await this.client.repository(metadata.parent.full_name, signal);
    }

    const existing = this.engine.db
      .repositories()
      .find(
        (r) =>
          (!managed || r.source !== "imported") &&
          `${r.owner}/${r.name}`.toLowerCase() === metadata.full_name.toLowerCase(),
      );

    if (existing) {
      if (
        managed &&
        existing.clone_status === "cloning" &&
        !this.cloneActivities().some(
          (a) => a.repository_id === existing.id && a.status === "cloning",
        )
      ) {
        return existing;
      }

      if (managed) {
        throw new AdeError(
          "repository_exists",
          `This repository is already registered from ${existing.path}. Connect that checkout explicitly.`,
        );
      }

      if (!deferred) {
        await this.engine.prepareClone(existing, undefined, localPath);
      }

      return existing;
    }

    const resolved = await this.resolve(metadata.full_name, signal);
    if (selectedFork) {
      resolved.origin_url = selectedFork;
    }

    return this.engine.register(
      resolved.upstream_url,
      resolved.origin_url,
      resolved.base_branch,
      deferred,
      localPath,
      !managed,
    );
  };

  refreshPullRequests = () => this.sync(false);

  sync = async (includeCatalog = true): Promise<ReturnType<GitHubService["snapshot"]>> => {
    if (this.running) {
      const catalogIncluded = this.syncingCatalog;
      const result = await this.running;
      return includeCatalog && !catalogIncluded ? this.sync(true) : result;
    }

    if (this.closed || this.stopping) {
      return Promise.resolve(this.snapshot());
    }

    const release = this.engine.trackActivity(
      {
        id: "github-sync",
        kind: "github_sync",
        label: "GitHub PR watch sync is running",
        stoppable: true,
      },
      this.stopSync,
    );

    this.syncingCatalog = includeCatalog;

    this.running = this.performSync(includeCatalog).finally(() => {
      this.running = undefined;
      release();
    });

    return this.running;
  };

  stopSync = async () => {
    this.stopping = true;
    this.controller.abort();
    try {
      await this.running;
    } finally {
      this.controller = new AbortController();
      this.stopping = false;
    }
  };

  private performSync = async (includeCatalog: boolean) => {
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(includeCatalog ? 120000 : 30000),
    ]);

    try {
      this.phase = "Checking GitHub connection";
      this.engine.changed();
      this.status = await this.client.detect(signal);
      signal.throwIfAborted();
      if (!this.status.connected || !this.status.username) {
        throw new AdeError(
          "github_auth",
          this.status.error || "Connect GitHub through Providers, then retry Refresh PR List.",
        );
      }

      if (includeCatalog) {
        this.phase = "Retrieving repository catalog";
        this.engine.changed();

        await this.client.pages<GitHubRepository>(
          "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed",
          signal,
        );
      }

      this.phase = "Refreshing pull request statuses";
      this.engine.changed();
      await this.client.authored(this.status.username, signal);
      const known = this.prs();

      const missing = known;
      if (missing.length) {
        this.phase = "Refreshing previously discovered pull requests";
        this.engine.changed();

        await this.client.pullRequests(
          missing.map((pr) => pr.url),
          signal,
        );
      }

      signal.throwIfAborted();
      const refreshed = now();
      this.lastSync = refreshed;
      this.error = null;
    } catch (error) {
      this.error = this.controller.signal.aborted
        ? null
        : signal.aborted
          ? "GitHub metadata refresh timed out. Saved results were preserved; retry refresh."
          : redact(error instanceof Error ? error.message : String(error));
    } finally {
      this.phase = null;

      this.engine.db.run(
        "INSERT INTO settings VALUES('github_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify({ last_sync: this.lastSync, error: this.error }),
      );
    }

    this.engine.changed();
    return this.snapshot();
  };

  // Kept for older callers: starting the service never schedules a GitHub read.
  start = () => {};

  close = async () => {
    this.closed = true;
    this.controller.abort();
    for (const clone of this.clones.values()) {
      clone.controller.abort();
    }

    await Promise.all([...this.clones.values()].map((c) => c.promise));
    await this.running;
  };
}
