import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../execution/runtime/process";
import { z } from "zod";
import { AdeError, now, remoteIdentity } from "../domain";
import type { Engine } from "../execution/engine";
import type { Scheduler } from "../scheduled/scheduler";
import { parsePullRequest } from "../scheduled/contracts";
import { GitHubClient } from "./client";
import { githubTransport } from "../workspace/git-command";
import {
  GitHubRepositorySchema,
  GitHubPullRequestSchema,
  type GitHubRepository,
  type GitHubPullRequest,
  type GitHubStatus,
} from "./contracts";

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
    if (!clone) throw new AdeError("not_found", "Clone activity not found.");
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
    )
      throw new AdeError("busy", "This repository is already being cloned.");
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
          if (controller.signal.aborted) throw new AdeError("cancelled", "Clone cancelled");
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

          if (repositoryId && !this.engine.db.tasks().some((t) => t.repo_id === repositoryId))
            this.engine.db.run("DELETE FROM repositories WHERE id=?", repositoryId);
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
    for (const [key, clone] of this.clones)
      if (this.clones.size > 20 && !["resolving", "cloning"].includes(clone.activity.status))
        this.clones.delete(key);
    this.engine.changed();
    return activity;
  };

  private controller = new AbortController();

  private running: Promise<unknown> | undefined;

  private status: GitHubStatus | null = null;

  private lastSync: string | null = null;

  private detailCursor = 0;

  private knownCursor = 0;

  private error: string | null = null;

  private phase: string | null = null;

  private stopping = false;

  private closed = false;

  readonly client: GitHubClient;

  constructor(
    private readonly engine: Engine,
    private readonly scheduler: Scheduler,
  ) {
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
    this.detailCursor = metadata?.detail_cursor || 0;
    this.knownCursor = metadata?.known_cursor || 0;
  }

  catalog = () =>
    this.engine.db.records.list<GitHubRepository>(
      "github_repositories",
      this.engine.db.all<{ id: number; data: string }>(
        "SELECT id,data FROM github_repositories ORDER BY full_name",
      ),
      GitHubRepositorySchema.parse,
      "id",
    );

  prs = () =>
    this.engine.db.records.list<GitHubPullRequest>(
      "github_pull_requests",
      this.engine.db.all<{ id: string; data: string }>(
        "SELECT url AS id,data FROM github_pull_requests ORDER BY updated_at DESC",
      ),
      GitHubPullRequestSchema.parse,
      "url",
    );

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
    if (value.auto_watch || value.verify_codex)
      throw new AdeError(
        "manual_policy",
        "PR inspection and analysis require an explicit user action. Automatic watching and second-model verification are disabled.",
      );

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
          )
            fork = info;
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

  configureDestination = async (input: unknown) => {
    const request = z
      .object({
        id: z.string().uuid(),
        repository: z.string().trim().min(1).max(2000),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(input);

    this.engine.assertAvailable();
    const repo = this.engine.db.repository(request.id);
    if (repo.source === "imported")
      throw new AdeError(
        "ownership",
        "Choose verified remotes from the local connection dialog. Vibestar does not rewrite user-owned checkout remotes.",
      );

    const url = githubTransport(
      request.repository.includes(":")
        ? request.repository
        : `https://github.com/${request.repository}`,
    );

    const identity = remoteIdentity(url);
    const name = `${identity.owner}/${identity.name}`;
    const upstream = `${repo.owner}/${repo.name}`;
    const signal = this.controller.signal;
    const source = GitHubRepositorySchema.parse(await this.client.repository(upstream, signal));

    const target =
      name.toLowerCase() === upstream.toLowerCase()
        ? source
        : GitHubRepositorySchema.parse(await this.client.repository(name, signal));

    if (
      source.id <= 0 ||
      target.id <= 0 ||
      source.full_name.toLowerCase() !== upstream.toLowerCase() ||
      target.full_name.toLowerCase() !== name.toLowerCase()
    )
      throw new AdeError(
        "github_identity",
        "The retrieved repository identity does not match this destination.",
      );
    if (!target.permissions?.push)
      throw new AdeError(
        "permission",
        "The connected GitHub account cannot push to this repository.",
      );
    if (
      target.id !== source.id &&
      (!target.fork ||
        target.parent?.id !== source.id ||
        target.parent.full_name.toLowerCase() !== upstream.toLowerCase())
    )
      throw new AdeError(
        "destination",
        "Choose the writable source repository or a verified contribution fork of it.",
      );

    signal.throwIfAborted();
    return this.engine.configureRepository(repo.id, {
      upstream_url: repo.upstream_url,
      origin_url: url,
      base_branch: repo.base_branch,
    });
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
    if (metadata.fork && metadata.parent)
      metadata = await this.client.repository(metadata.parent.full_name, signal);

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
      )
        return existing;
      if (managed)
        throw new AdeError(
          "repository_exists",
          `This repository is already registered from ${existing.path}. Connect that checkout explicitly.`,
        );
      if (!deferred) await this.engine.prepareClone(existing, undefined, localPath);
      return existing;
    }

    const resolved = await this.resolve(metadata.full_name, signal);
    if (selectedFork) resolved.origin_url = selectedFork;
    return this.engine.register(
      resolved.upstream_url,
      resolved.origin_url,
      resolved.base_branch,
      deferred,
      localPath,
      !managed,
    );
  };

  sync = () => {
    if (this.running) return this.running;
    if (this.closed || this.stopping) return Promise.resolve(this.snapshot());

    const release = this.engine.trackActivity(
      {
        id: "github-sync",
        kind: "github_sync",
        label: "GitHub PR watch sync is running",
        stoppable: true,
      },
      this.stopSync,
    );

    this.running = this.performSync().finally(() => {
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

  private performSync = async () => {
    try {
      this.phase = "Checking GitHub connection";
      this.engine.changed();
      this.status = await this.client.detect(this.controller.signal);
      this.engine.changed();
      if (!this.status.connected || !this.status.username)
        throw new AdeError(
          "github_auth",
          this.status.error || "Connect GitHub through Providers, then retry Refresh PR List.",
        );
      this.phase = "Retrieving repository catalog";
      this.engine.changed();

      const repos = await this.client.pages<GitHubRepository>(
        "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed",
        this.controller.signal,
      );

      this.phase = "Discovering authored pull requests";
      this.engine.changed();
      const found = await this.client.authored(this.status.username, this.controller.signal);
      const urls = new Set(found.map((p) => p.html_url));
      const savedPRs = this.prs();

      const knownMissing = new Set(
        [...savedPRs.map((pr) => pr.url), ...this.scheduler.jobs().map((job) => job.url)].filter(
          (url) => !urls.has(url),
        ),
      );

      const detailBudget = 500 - Math.min(100, knownMissing.size);
      const cursor = this.detailCursor % Math.max(1, found.length);

      const sorted = [...found].sort(
        (a, b) => b.updated_at.localeCompare(a.updated_at) || a.html_url.localeCompare(b.html_url),
      );

      const bounded = sorted.slice(cursor, cursor + detailBudget);
      let partial =
        found.length > bounded.length
          ? `Partial refresh: inspected ${bounded.length} of ${found.length} authored PRs. Refresh again to inspect the next saved page; previous results remain.`
          : "";
      const updates: GitHubPullRequest[] = [];
      for (const pr of bounded) {
        this.phase = `Retrieving pull request details · ${updates.length + 1} of ${found.length}`;
        this.engine.changed();
        const ref = parsePullRequest(pr.html_url);

        const info = await this.client
          .api<{
            head: {
              ref: string;
              sha?: string;
              repo: { full_name: string } | null;
            };
            state: string;
            merged: boolean;
            draft?: boolean;
            title?: string;
            updated_at?: string;
          }>(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, this.controller.signal)
          .catch((error) => {
            if (!this.controller.signal.aborted)
              this.recordInaccessible(
                savedPRs.find((old) => old.url === pr.html_url) || {
                  url: pr.html_url,
                  repository: `${ref.owner}/${ref.repo}`,
                  number: pr.number,
                  title: pr.title,
                  state: "UNKNOWN",
                  head_branch: "",
                  head_repository: null,
                  updated_at: pr.updated_at,
                  task_id: null,
                },
                error,
              );
            throw error;
          });

        const repository = `${ref.owner}/${ref.repo}`;

        // Both upstream identity and fork + head branch must agree, uniquely.
        const matches = this.engine.db.tasks().filter((t) => {
          const repo = this.engine.db.repository(t.repo_id);
          return (
            `${repo.owner}/${repo.name}`.toLowerCase() === repository.toLowerCase() &&
            t.branch_name === info.head.ref &&
            (repo.origin_url || repo.upstream_url)
              .replace(/^git@github.com:/, "https://github.com/")
              .replace(/\.git$/, "")
              .toLowerCase() === `https://github.com/${info.head.repo?.full_name}`.toLowerCase()
          );
        });

        const value: GitHubPullRequest = {
          url: pr.html_url,
          repository,
          number: pr.number,
          title: info.title || pr.title,
          state: info.merged ? "MERGED" : info.state === "closed" ? "CLOSED" : "OPEN",
          draft: info.draft,
          head_sha: info.head.sha,
          head_branch: info.head.ref,
          head_repository: info.head.repo?.full_name || null,
          updated_at: info.updated_at || pr.updated_at,
          task_id: matches.length === 1 ? matches[0].id : null,
        };

        updates.push(value);
      }

      // Missing search results are not proof of closure. Confirm each known PR.
      this.phase = "Checking previously discovered pull requests";
      this.engine.changed();
      const known = [...savedPRs];
      for (const job of this.scheduler.jobs()) {
        if (known.some((pr) => pr.url.toLowerCase() === job.url.toLowerCase())) continue;
        const ref = parsePullRequest(job.url);

        known.push({
          url: ref.url,
          repository: `${ref.owner}/${ref.repo}`,
          number: ref.number,
          title: job.title || job.last_snapshot?.title || `PR #${ref.number}`,
          state: job.last_snapshot?.state || "UNKNOWN",
          head_branch: "",
          head_repository: null,
          updated_at: job.last_checked_at || "",
          task_id: job.task_id,
        });
      }

      const missing = known.filter((p) => !urls.has(p.url));
      const remaining = Math.max(0, 500 - bounded.length);
      const knownCursor = this.knownCursor % Math.max(1, missing.length);
      const rechecked = missing.slice(knownCursor, knownCursor + remaining);
      if (missing.length > rechecked.length)
        partial =
          `${partial} Partial refresh: ${missing.length - rechecked.length} previously known PRs were not rechecked within the detail budget.`.trim();
      for (const old of rechecked) {
        const ref = parsePullRequest(old.url);

        const info = await this.client
          .api<{
            state: string;
            merged: boolean;
            draft?: boolean;
            updated_at?: string;
            head?: {
              ref: string;
              sha: string;
              repo: { full_name: string } | null;
            };
          }>(`repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, this.controller.signal)
          .catch((error) => {
            if (!this.controller.signal.aborted) this.recordInaccessible(old, error);
            throw error;
          });

        if (["open", "closed"].includes(info.state)) {
          const value = {
            ...old,
            state: info.merged ? "MERGED" : info.state === "closed" ? "CLOSED" : "OPEN",
            draft: info.draft ?? old.draft,
            head_sha: info.head?.sha || old.head_sha,
            head_branch: info.head?.ref || old.head_branch,
            head_repository: info.head?.repo?.full_name || old.head_repository,
            updated_at: info.updated_at || old.updated_at,
            access_error: undefined,
            last_known_state: undefined,
          };

          updates.push(value);
        }
      }

      const catalogTime = now();

      this.engine.db.transaction(() => {
        for (const repo of repos)
          this.engine.db.run(
            "INSERT INTO github_repositories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name,data=excluded.data,synced_at=excluded.synced_at",
            repo.id,
            repo.full_name,
            JSON.stringify(repo),
            catalogTime,
          );
        this.engine.db.run("DELETE FROM github_repositories WHERE synced_at<>?", catalogTime);
        for (const value of updates) this.savePR(value);
      });

      for (const value of updates) this.scheduler.discovered(value);
      this.detailCursor = (cursor + bounded.length) % Math.max(1, found.length);
      this.knownCursor = (knownCursor + rechecked.length) % Math.max(1, missing.length);
      if (!partial) this.lastSync = now();
      this.error = partial || null;
    } catch (e) {
      this.error = this.controller.signal.aborted
        ? null
        : e instanceof Error
          ? e.message
          : String(e);
    } finally {
      this.phase = null;

      this.engine.db.run(
        "INSERT INTO settings VALUES('github_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify({
          last_sync: this.lastSync,
          error: this.error,
          detail_cursor: this.detailCursor,
          known_cursor: this.knownCursor,
        }),
      );
    }

    this.engine.changed();
    return this.snapshot();
  };

  private savePR = (pr: GitHubPullRequest) => {
    if (pr.task_id && !this.engine.db.tasks().some((t) => t.id === pr.task_id))
      pr = { ...pr, task_id: null };
    return this.engine.db.run(
      "INSERT INTO github_pull_requests VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at",
      pr.url,
      JSON.stringify(pr),
      pr.updated_at,
    );
  };

  private recordInaccessible = (pr: GitHubPullRequest, error: unknown) => {
    const value = {
      ...pr,
      state: "UNKNOWN",
      last_known_state: pr.state === "UNKNOWN" ? pr.last_known_state : pr.state,
      access_error: redact(error instanceof Error ? error.message : String(error)).slice(-3000),
    };

    this.savePR(value);
    this.scheduler.discovered(value);
  };

  // Kept for older callers: starting the service never schedules a GitHub read.
  start = () => {};

  close = async () => {
    this.closed = true;
    this.controller.abort();
    for (const clone of this.clones.values()) clone.controller.abort();
    await Promise.all([...this.clones.values()].map((c) => c.promise));
    await this.running;
  };
}
