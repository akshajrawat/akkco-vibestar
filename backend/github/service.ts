import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../execution/process";
import { z } from "zod";
import { AdeError, now } from "../domain";
import type { Engine } from "../execution/engine";
import type { Scheduler } from "../scheduled/scheduler";
import { parsePullRequest } from "../scheduled/contracts";
import { GitHubClient } from "./client";
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
        const log = await open(
          join(this.engine.root, "logs", `clone-${id}.log`),
          "a",
          0o600,
        );
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
          const repo = await this.useLocally(
            name,
            true,
            undefined,
            true,
            controller.signal,
          );
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
          await this.engine.prepareClone(
            repo,
            controller.signal,
            undefined,
            progress,
          );
          if (controller.signal.aborted)
            throw new AdeError("cancelled", "Clone cancelled");
          repo.connected = true;
          this.engine.db.saveRepository(repo);
          activity.status = "completed";
          activity.phase = "Ready";
          activity.percent = 100;
        } catch (error) {
          activity.status = controller.signal.aborted ? "cancelled" : "failed";
          activity.error = redact(
            error instanceof Error ? error.message : String(error),
          );
          activity.phase = controller.signal.aborted
            ? "Clone cancelled · incomplete managed checkout removed"
            : "Clone failed";
          if (
            repositoryId &&
            !this.engine.db.tasks().some((t) => t.repo_id === repositoryId)
          )
            this.engine.db.run(
              "DELETE FROM repositories WHERE id=?",
              repositoryId,
            );
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
      if (
        this.clones.size > 20 &&
        !["resolving", "cloning"].includes(clone.activity.status)
      )
        this.clones.delete(key);
    this.engine.changed();
    return activity;
  };
  private controller = new AbortController();
  private running: Promise<unknown> | undefined;
  private status: GitHubStatus | null = null;
  private lastSync: string | null = null;
  private error: string | null = null;
  private stopping = false;
  private closed = false;
  readonly client: GitHubClient;
  constructor(
    private readonly engine: Engine,
    private readonly scheduler: Scheduler,
  ) {
    this.client = new GitHubClient(engine.root);
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
    settings: this.settings(),
    repositories: this.catalog(),
    pull_requests: this.prs(),
  });
  resolve = async (name: string, signal = this.controller.signal) => {
    const repository = await this.client.repository(name, signal);
    let fork: GitHubRepository | undefined;
    const status = this.status || (await this.client.detect(signal));
    if (status.connected) {
      const candidates = this.catalog().filter(
        (r) =>
          r.fork &&
          r.owner.login === status.username &&
          r.name === repository.name,
      );
      for (const candidate of candidates) {
        const info = await this.client.repository(candidate.full_name, signal);
        if (
          info.parent?.full_name.toLowerCase() ===
          repository.full_name.toLowerCase()
        ) {
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
            info.parent?.full_name.toLowerCase() ===
              repository.full_name.toLowerCase()
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
  useLocally = async (
    name: string,
    deferred = false,
    localPath?: string,
    managed = false,
    signal = this.controller.signal,
  ) => {
    let metadata = await this.client.repository(name, signal);
    const selectedFork =
      metadata.fork && metadata.parent ? metadata.clone_url : null;
    if (metadata.fork && metadata.parent)
      metadata = await this.client.repository(
        metadata.parent.full_name,
        signal,
      );
    const existing = this.engine.db
      .repositories()
      .find(
        (r) =>
          (!managed || r.source !== "imported") &&
          `${r.owner}/${r.name}`.toLowerCase() ===
            metadata.full_name.toLowerCase(),
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
      if (!deferred)
        await this.engine.prepareClone(existing, undefined, localPath);
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
      this.status = await this.client.detect(this.controller.signal);
      this.engine.changed();
      if (!this.status.connected || !this.status.username)
        return this.snapshot();
      const repos = await this.client.pages<GitHubRepository>(
        "user/repos?affiliation=owner,collaborator,organization_member&sort=pushed",
        this.controller.signal,
      );
      const catalogTime = now();
      for (const repo of repos)
        this.engine.db.run(
          "INSERT INTO github_repositories VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name,data=excluded.data,synced_at=excluded.synced_at",
          repo.id,
          repo.full_name,
          JSON.stringify(repo),
          catalogTime,
        );
      this.engine.db.run(
        "DELETE FROM github_repositories WHERE synced_at<>?",
        catalogTime,
      );
      const found = await this.client.authored(
        this.status.username,
        this.controller.signal,
      );
      const urls = new Set(found.map((p) => p.html_url));
      for (const pr of found) {
        const ref = parsePullRequest(pr.html_url);
        const info = await this.client.api<{
          head: { ref: string; repo: { full_name: string } | null };
          state: string;
          merged: boolean;
        }>(
          `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
          this.controller.signal,
        );
        const repository = `${ref.owner}/${ref.repo}`;
        // Both upstream identity and fork + head branch must agree, uniquely.
        const matches = this.engine.db.tasks().filter((t) => {
          const repo = this.engine.db.repository(t.repo_id);
          return (
            `${repo.owner}/${repo.name}`.toLowerCase() ===
              repository.toLowerCase() &&
            t.branch_name === info.head.ref &&
            (repo.origin_url || repo.upstream_url)
              .replace(/^git@github.com:/, "https://github.com/")
              .replace(/\.git$/, "")
              .toLowerCase() ===
              `https://github.com/${info.head.repo?.full_name}`.toLowerCase()
          );
        });
        const saved = this.prs().find((p) => p.url === pr.html_url);
        const value: GitHubPullRequest = {
          url: pr.html_url,
          repository,
          number: pr.number,
          title: pr.title,
          state: "OPEN",
          head_branch: info.head.ref,
          head_repository: info.head.repo?.full_name || null,
          updated_at: pr.updated_at,
          task_id:
            saved?.task_id || (matches.length === 1 ? matches[0].id : null),
        };
        this.savePR(value);
        this.scheduler.discovered(value);
      }
      // Missing search results are not proof of closure. Confirm each known PR.
      for (const old of this.prs().filter(
        (p) => p.state === "OPEN" && !urls.has(p.url),
      )) {
        const ref = parsePullRequest(old.url);
        const info = await this.client.api<{ state: string; merged: boolean }>(
          `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
          this.controller.signal,
        );
        if (info.state === "closed") {
          const value = {
            ...old,
            state: info.merged ? "MERGED" : "CLOSED",
            updated_at: now(),
          };
          this.savePR(value);
          this.scheduler.discovered(value);
        }
      }
      this.lastSync = now();
      this.error = null;
    } catch (e) {
      this.error = this.controller.signal.aborted
        ? null
        : e instanceof Error
          ? e.message
          : String(e);
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
