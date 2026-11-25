import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { z } from "zod";

import { AdeError, now, remoteIdentity, type Repository } from "../../domain";
import type { RepositoryIndex } from "../../workspace/discovery";
import { ConnectLocalInput, type LocalRepositoryInput } from "../../workspace/discovery";
import { gitChecked } from "../../workspace/git-command";
import { exists, inside, managedPath } from "../../workspace/paths";
import type { Engine } from "../engine";

/** Owns repository connection and clone operations under the engine maintenance lease. */
export class RepositoryOperations {
  constructor(
    private readonly host: Pick<
      Engine,
      | "assertAvailable"
      | "db"
      | "root"
      | "repositoryIndex"
      | "changed"
      | "git"
      | "isActive"
      | "cleanupBlockers"
    >,
    private readonly operation: <T>(operation: () => Promise<T>, label?: string) => Promise<T>,
    private readonly signal: AbortSignal,
  ) {}

  register = (...args: Parameters<RepositoryOperations["registerData"]>) =>
    this.operation(() => this.registerData(...args));

  private registerData = async (
    upstream: string,
    origin: string | null,
    base: string,
    deferred = false,
    localPath?: string,
    discover = true,
  ) => {
    this.host.assertAvailable();
    const { owner, name } = remoteIdentity(upstream);
    if (origin) {
      remoteIdentity(origin);
    }

    if (
      discover &&
      this.host.db
        .repositories()
        .some(
          (r) =>
            r.owner.toLowerCase() === owner.toLowerCase() &&
            r.name.toLowerCase() === name.toLowerCase(),
        )
    ) {
      throw new AdeError("repository_exists", "Repository is already registered");
    }

    await gitChecked(["check-ref-format", "--branch", base], this.host.root);
    if (discover && !localPath) {
      await this.host.repositoryIndex.scan();
    }

    const candidate = localPath
      ? await this.host.repositoryIndex.inspect(localPath)
      : discover
        ? this.host.repositoryIndex.matches(`${owner}/${name}`)[0]
        : undefined;

    if (candidate && !candidate.identities.includes(`${owner}/${name}`.toLowerCase())) {
      throw new AdeError(
        "repository_mismatch",
        "Selected checkout does not have a matching GitHub remote.",
      );
    }

    const id = randomUUID();

    const r: Repository = {
      id,
      owner,
      name,
      upstream_url: upstream,
      origin_url: origin,
      base_branch: base,
      path: candidate?.path || join(this.host.root, "repos", id),
      source: candidate ? "imported" : "managed",
      connected: !(!discover && deferred),
      ...(!discover && deferred ? { clone_status: "cloning" as const } : {}),
      ...(!discover ? { selection: "explicit" as const } : {}),
      last_fetched: null,
      created_at: now(),
    };

    this.host.db.saveRepository(r);
    if (!deferred) {
      try {
        await this.prepareClone(r);
      } catch (error) {
        this.host.db.run("DELETE FROM repositories WHERE id=?", r.id);
        throw error;
      }
    }

    this.host.changed();
    return r;
  };

  prepareClone = (
    r: Repository,
    signal = this.signal,
    localPath?: string,
    onProgress?: (line: string) => void,
  ) =>
    this.operation(() =>
      this.host.git.withLock(r.id, async () => {
        if (r.source === "imported") {
          const candidate = await this.host.repositoryIndex.inspect(r.path);
          if (!candidate.identities.includes(`${r.owner}/${r.name}`.toLowerCase())) {
            throw new AdeError(
              "repository_mismatch",
              "Imported checkout remotes no longer match this repository.",
            );
          }

          return;
        }

        await managedPath(this.host.root, r.path);
        // A caller can wait behind the original clone's lock. Refresh its
        // marker before deciding whether an incomplete destination is removable.
        if (r.clone_status === "cloning") {
          const current = this.host.db.repository(r.id);
          if (current.clone_status === "ready") {
            Object.assign(r, current);
          }
        }

        if (r.clone_status === "cloning" && (await exists(r.path))) {
          if (
            !inside(join(this.host.root, "repos"), r.path) ||
            this.host.db.all("SELECT id FROM viber_sessions WHERE repository_id=?", r.id).length
          ) {
            throw new AdeError(
              "isolation",
              "Cannot remove an incomplete clone with session history or external ownership.",
            );
          }

          await rm(r.path, { recursive: true, force: true });
        }

        if (await exists(join(r.path, ".git"))) {
          return;
        }

        if (r.selection !== "explicit") {
          await this.host.repositoryIndex.scan();
        }

        const existing = localPath
          ? await this.host.repositoryIndex.inspect(localPath)
          : r.selection !== "explicit"
            ? this.host.repositoryIndex.matches(`${r.owner}/${r.name}`)[0]
            : undefined;

        if (existing) {
          if (!existing.identities.includes(`${r.owner}/${r.name}`.toLowerCase())) {
            throw new AdeError(
              "repository_mismatch",
              "Selected checkout does not have a matching GitHub remote.",
            );
          }

          if (
            this.host.db.all(
              "SELECT id FROM viber_sessions WHERE repository_id=? AND workspace IS NOT NULL AND json_extract(workspace, '$.worktree_path') IS NOT NULL",
              r.id,
            ).length
          ) {
            throw new AdeError(
              "isolation",
              "This repository has existing session worktrees. Restore its original managed clone before continuing.",
            );
          }

          r.path = existing.path;
          r.source = "imported";
          this.host.db.saveRepository(r);
          return;
        }

        try {
          await this.host.git.clone(r.upstream_url, r.path, signal, onProgress);
          onProgress?.("Configuring remotes…");
          if (r.origin_url) {
            await gitChecked(["remote", "add", "origin", r.origin_url], r.path, signal);
          }

          await this.host.git.fetch(r, signal);

          await gitChecked(
            ["rev-parse", "--verify", `refs/remotes/upstream/${r.base_branch}^{commit}`],
            r.path,
            signal,
          );

          r.clone_status = "ready";
          this.host.db.saveRepository(r);
        } catch (error) {
          if (inside(join(this.host.root, "repos"), r.path)) {
            await managedPath(this.host.root, r.path);
            await rm(r.path, { recursive: true, force: true });
          }

          throw error;
        }
      }),
    );

  private readonly localVerifications = new Map<
    string,
    {
      input: z.infer<typeof LocalRepositoryInput>;
      result: Awaited<ReturnType<RepositoryIndex["verifyLocal"]>>;
      expires: number;
    }
  >();

  verifyLocalRepository = (input: z.infer<typeof LocalRepositoryInput>) =>
    this.operation(async () => {
      const result = await this.host.repositoryIndex.verifyLocal(input);
      for (const [id, verification] of this.localVerifications) {
        if (verification.expires < Date.now()) {
          this.localVerifications.delete(id);
        }
      }

      if (this.localVerifications.size >= 100) {
        this.localVerifications.delete(this.localVerifications.keys().next().value!);
      }

      const verification_id = randomUUID();

      this.localVerifications.set(verification_id, {
        input,
        result,
        expires: Date.now() + 10 * 60 * 1000,
      });

      return { ...result, verification_id };
    }, "Local repository verification is running");

  connectLocalRepository = (input: z.infer<typeof ConnectLocalInput>) =>
    this.operation(async () => {
      const p = ConnectLocalInput.parse(input);
      const verification = this.localVerifications.get(p.verification_id);
      if (!verification || verification.expires < Date.now()) {
        throw new AdeError(
          "invalid_input",
          "Verification expired. Verify the repository again before connecting.",
        );
      }

      const current = await this.host.repositoryIndex.verifyLocal(verification.input);
      if (
        current.path !== verification.result.path ||
        JSON.stringify(current.remotes) !== JSON.stringify(verification.result.remotes)
      ) {
        throw new AdeError(
          "repository_changed",
          "Repository location or remotes changed. Verify again before connecting.",
        );
      }

      const upstream = current.remotes.find((r) => r.name === p.upstream_remote && r.identity);

      const origin = p.origin_remote
        ? current.remotes.find((r) => r.name === p.origin_remote && r.identity)
        : null;

      if (!upstream || (p.origin_remote && !origin)) {
        throw new AdeError(
          "invalid_input",
          "Choose verified GitHub remotes for upstream and origin.",
        );
      }

      if (origin?.name === upstream.name) {
        throw new AdeError(
          "invalid_input",
          "Upstream and fork must use different remotes. Choose None if there is no fork.",
        );
      }

      await gitChecked(["check-ref-format", "--branch", p.base_branch], current.path);
      if (!current.branches.includes(p.base_branch)) {
        throw new AdeError("invalid_input", "Choose a base branch found in this repository.");
      }

      const { owner, name } = remoteIdentity(upstream.url);

      const existing = this.host.db
        .repositories()
        .find(
          (r) =>
            r.path === current.path &&
            `${r.owner}/${r.name}`.toLowerCase() === `${owner}/${name}`.toLowerCase(),
        );

      const blockers = this.host.cleanupBlockers();
      if (blockers.length) {
        throw new AdeError("busy", "Wait for active operations before reconnecting.");
      }

      const repo: Repository = {
        id: existing?.id || randomUUID(),
        owner,
        name,
        path: current.path,
        upstream_url: upstream.url,
        origin_url: origin?.url || null,
        upstream_remote: upstream.name,
        origin_remote: origin?.name || null,
        base_branch: p.base_branch,
        source: "imported",
        connected: true,
        selection: "explicit",
        environment: current.environment,
        distro: current.distro,
        ...(current.windows_path ? { windows_path: current.windows_path } : {}),
        last_fetched: existing?.last_fetched || null,
        created_at: existing?.created_at || now(),
      };

      this.host.db.saveRepository(repo);
      this.localVerifications.delete(p.verification_id);
      this.host.changed();
      return repo;
    }, "Local repository connection is running");

  disconnectRepository = (id: string) =>
    this.operation(async () => {
      const repo = this.host.db.repository(id);

      const blockers = this.host.cleanupBlockers();
      if (blockers.length) {
        throw new AdeError("busy", "Stop active operations before disconnecting this repository.", {
          blockers,
        });
      }

      this.host.db.saveRepository({ ...repo, connected: false });
      this.host.changed();
      return null;
    }, "Repository disconnection is running");

  reconnectRepository = (id: string) =>
    this.operation(async () => {
      const repo = this.host.db.repository(id);
      if (repo.source === "imported") {
        throw new AdeError("invalid_input", "Verify the local checkout before reconnecting it.");
      }

      repo.selection = "explicit";
      await this.prepareClone(repo);
      repo.connected = true;
      this.host.db.saveRepository(repo);
      this.host.changed();
      return repo;
    }, "Managed repository reconnection is running");

  verifyRepository = (id: string) =>
    this.operation(async () => {
      const repo = this.host.db.repository(id);
      return this.host.repositoryIndex.verifyLocal(
        { environment: "wsl", path: repo.path },
        repo.source !== "imported",
      );
    }, "Repository verification is running");

  fetchRepository = (id: string) =>
    this.operation(() => this.fetchRepositoryData(id), "Repository fetch is running");

  private fetchRepositoryData = async (id: string) => {
    const r = this.host.db.repository(id);
    await this.prepareClone(r);

    await this.host.git.withLock(id, async () => {
      await this.host.git.fetch(r, this.signal);
      this.host.db.saveRepository(r);
    });

    this.host.changed();
    return r;
  };
}
