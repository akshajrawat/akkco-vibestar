import { gitExecute, gitCapture } from "../../workspace/git-command";
import { CommitMessageSchema, createExactCommit } from "../../workspace/commit-message";
import { publishFastForward } from "../../workspace/publication";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdeError, now } from "../../domain";
import type { Engine } from "../../execution/engine";
import { execute, redact } from "../../execution/runtime/process";
import { managedPath, safeFile } from "../../workspace/paths";
import type { RepairStore } from "./store";
import type { RepairWorkspaces } from "./workspace";
import { repairAssignment } from "./workspace";
import type { PRIdentity, RepairSession } from "./contracts";

export const PublicationSchema = z
  .object({
    pid: z.number().int().positive().nullable().optional(),
    process_identity: z.string().nullable().optional(),
    id: z.string().uuid(),
    repair_id: z.string().uuid(),
    pr_url: z.string().url(),
    destination: z
      .object({
        repository: z.string(),
        repository_id: z.string(),
        url: z.string(),
        branch: z.string(),
      })
      .strict(),
    expected_remote_head: z.string(),
    local_head: z.string(),
    fingerprint: z.string(),
    upstream_base: z.object({ branch: z.string(), sha: z.string() }).strict(),
    dirty: z.boolean(),
    changes: z
      .object({
        files: z.number().int(),
        additions: z.number().int(),
        deletions: z.number().int(),
      })
      .strict(),
    validation: z
      .object({
        observed_passed: z.number().int(),
        observed_failed: z.number().int(),
        reported_blocked: z.number().int(),
      })
      .strict(),
    commits: z.array(
      z.object({ sha: z.string(), parents: z.string(), subject: z.string() }).strict(),
    ),
    confirmation: z
      .object({
        viewer: z.string(),
        approved_at: z.string(),
        reviewed_hash: z.string(),
        confirmed_at: z.string().nullable(),
      })
      .strict(),
    outcome: z.enum([
      "prepared",
      "pushing",
      "published",
      "not_published",
      "stale_remote_head",
      "uncertain",
    ]),
    error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    published_at: z.string().nullable(),
  })
  .strict();

export type RepairPublication = z.infer<typeof PublicationSchema>;

export class RepairPublisher {
  constructor(
    private readonly engine: Engine,
    private readonly store: RepairStore,
    private readonly workspaces: RepairWorkspaces,
    private readonly readIdentity: (url: string, signal: AbortSignal) => Promise<PRIdentity>,
    private readonly transport?: (identity: PRIdentity) => string,
    private readonly push = execute,
  ) {}

  private save = (publication: RepairPublication) => {
    publication.updated_at = now();

    this.engine.db.run(
      "INSERT INTO repair_publications VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,updated_at=excluded.updated_at",
      publication.id,
      publication.repair_id,
      publication.outcome,
      JSON.stringify(PublicationSchema.parse(publication)),
      publication.created_at,
      publication.updated_at,
    );
  };

  get = (repairId: string, id: string) => {
    const row = this.engine.db.all<{ data: string }>(
      "SELECT data FROM repair_publications WHERE id=? AND repair_id=?",
      id,
      repairId,
    )[0];

    if (!row) throw new AdeError("not_found", "Publication does not belong to this repair.");
    return this.engine.db.records.decode(
      {
        table: "repair_publications",
        id,
        column: "data",
        source: row.data,
        identity: "id",
      },
      PublicationSchema.parse,
    );
  };

  private git = async (
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    session?: RepairSession,
  ) => {
    let finished = false;
    try {
      const result = await gitExecute({
        program: "git",
        allowLocalTransport: !!this.transport,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "gc.auto=0",
          ...args,
        ],
        cwd,
        signal,
        onSpawn: session
          ? (pid, identity) => {
              if (finished || !identity) return;

              session.workspace.operation = {
                kind: args.includes("commit") ? "commit" : args[0],
                pid,
                identity,
                started_at: now(),
              };

              this.store.save(session);
            }
          : undefined,
      });

      if (result.code !== 0)
        throw new AdeError("git_repair", `git ${args[0]} exited ${result.code}: ${result.stderr}`);
      return result.stdout.trim();
    } finally {
      finished = true;
      if (session) {
        session.workspace.operation = null;
        this.store.save(session);
      }
    }
  };

  private workspace = async (session: RepairSession) => {
    const cwd = await this.workspaces.assert(session, this.engine.db.repository(session.repo_id));
    if (
      (await gitCapture(["rev-parse", "--verify", "MERGE_HEAD"], cwd)).code === 0 ||
      (await this.git(cwd, ["ls-files", "--unmerged"]))
    )
      throw new AdeError("merge_conflict", "Resolve and finish the merge before finalizing.");
    return cwd;
  };

  approve = async (session: RepairSession, expectedHash: string) => {
    if (
      session.status !== "awaiting_manual_review" ||
      !session.review_hash ||
      session.review_hash !== expectedHash ||
      session.verification?.overall !== "approved" ||
      session.verification.items.some((i) => i.status !== "accepted") ||
      !session.implementation ||
      session.implementation.items.some((i) => ["blocked", "unresolved"].includes(i.status))
    )
      throw new AdeError(
        "manual_review",
        "Successful independent verification and the exact reviewed workspace are required before approval.",
      );
    await this.workspace(session);
    if ((await this.engine.git.repairFingerprint(repairAssignment(session))) !== expectedHash)
      throw new AdeError(
        "review_changed",
        "Files, index or commits changed since review. Request a fresh review before approving.",
      );
    session.approved_hash = expectedHash;

    this.store.activity(session, "manual_approval", {
      viewer: session.identity.viewer,
      approved_at: now(),
      reviewed_hash: expectedHash,
    });

    this.store.transition(session, "ready_to_publish");
  };

  commit = async (
    session: RepairSession,
    expectedHash: string,
    message: string,
    signal: AbortSignal,
  ) => {
    CommitMessageSchema.parse(message);
    if (session.status !== "ready_to_publish" || session.approved_hash !== expectedHash)
      throw new AdeError(
        "manual_review",
        "Approve the reviewed workspace before preparing a local commit.",
      );
    const repo = this.engine.db.repository(session.repo_id);
    return this.engine.git.withLock(repo.id, async () => {
      const cwd = await this.workspace(session);
      const assignment = repairAssignment(session);
      if ((await this.engine.git.repairFingerprint(assignment)) !== expectedHash)
        throw new AdeError("review_changed", "The approved workspace changed before committing.");
      const content = await this.engine.git.repairFingerprint(assignment, false);
      const parent = await this.git(cwd, ["rev-parse", "HEAD"]);
      const diff = await this.engine.git.diff(assignment);
      for (const file of diff.files) await safeFile(cwd, file.path);
      const clean = !(await this.git(cwd, ["status", "--porcelain", "--untracked-files=all"]));
      if (!clean) {
        this.store.activity(session, "commit_intent", {
          parent,
          fingerprint: expectedHash,
          content,
          message,
        });

        await this.git(cwd, ["add", "--all", "--", "."], signal, session);
        if (content !== (await this.engine.git.repairFingerprint(assignment, false)))
          throw new AdeError(
            "review_changed",
            "Workspace changed while staging. Preserve the index and review again.",
          );
        const checkedDiff = await gitCapture(["diff", "--cached", "--check"], cwd, signal);
        if (checkedDiff.code !== 0)
          throw new AdeError("commit_validation", checkedDiff.stdout || checkedDiff.stderr);
        const tree = await this.git(cwd, ["write-tree"], signal, session);
        const commit = await createExactCommit(cwd, tree, parent, message, signal);
        await this.git(cwd, ["update-ref", "HEAD", commit, parent], signal, session);
      }

      if (content !== (await this.engine.git.repairFingerprint(assignment, false)))
        throw new AdeError(
          "review_changed",
          "Commit content differs from the reviewed workspace. Publishing remains blocked.",
        );
      const head = await this.git(cwd, ["rev-parse", "HEAD"]);
      session.review_hash = await this.engine.git.repairFingerprint(assignment);
      session.approved_hash = session.review_hash;
      this.store.save(session);

      this.store.activity(session, "local_commit", {
        parent,
        head,
        reviewed_content: content,
        approved_hash: session.approved_hash,
        message,
        local_only: true,
      });

      return { head, fingerprint: session.approved_hash };
    });
  };

  prepare = async (session: RepairSession, signal: AbortSignal) => {
    if (session.status !== "ready_to_publish" || !session.approved_hash)
      throw new AdeError(
        "manual_review",
        "Explicit manual approval is required before preparing publication.",
      );

    const uncertain = this.engine.db.all(
      "SELECT id FROM repair_publications WHERE repair_id=? AND status IN ('pushing','uncertain')",
      session.id,
    );

    if (uncertain.length)
      throw new AdeError(
        "publication_uncertain",
        "Reconcile the existing publication read-only before preparing another push.",
      );
    const cwd = await this.workspace(session);
    const fingerprint = await this.engine.git.repairFingerprint(repairAssignment(session));
    if (fingerprint !== session.approved_hash)
      throw new AdeError(
        "review_changed",
        "The reviewed workspace changed. Publishing requires fresh manual review.",
      );
    const fresh = await this.readIdentity(session.identity.url, signal);
    this.validateIdentity(session, fresh);
    if (!fresh.can_push)
      throw new AdeError(
        "permission",
        "The authenticated GitHub account cannot push to the PR's source repository.",
      );
    const remote = await this.workspaces.remoteHead(fresh, cwd, signal);
    if (remote !== session.workspace.original_head || fresh.head.sha !== remote)
      throw new AdeError(
        "stale_remote_head",
        "The remote PR head changed. This repair cannot publish stale changes.",
      );
    const head = await this.git(cwd, ["rev-parse", "HEAD"]);
    if (
      (await gitCapture(["merge-base", "--is-ancestor", remote, head], cwd)).code !== 0 ||
      !session.workspace.fetched_base ||
      (await gitCapture(["merge-base", "--is-ancestor", session.workspace.fetched_base, head], cwd))
        .code !== 0
    )
      throw new AdeError(
        "ancestry",
        "Publication must preserve both the original PR and fetched upstream ancestry.",
      );

    const diff = await this.engine.git.diff({
      ...repairAssignment(session),
      base_commit_sha: session.workspace.original_head,
    });

    const tests = this.engine.db.all<{ status: string }>(
      "SELECT status FROM test_runs WHERE repair_id=?",
      session.id,
    );

    const approval = this.engine.db.all<{ id: number; data: string }>(
      "SELECT id,data FROM repair_activity WHERE repair_id=? AND kind='manual_approval' ORDER BY id DESC LIMIT 1",
      session.id,
    )[0];

    if (!approval) throw new AdeError("manual_review", "Manual approval evidence is missing.");

    const confirmation = this.engine.db.records.decode(
      {
        table: "repair_activity",
        id: approval.id,
        column: "data",
        source: approval.data,
      },
      PublicationSchema.shape.confirmation.omit({ confirmed_at: true }).parse,
    );

    if (confirmation.viewer !== fresh.viewer)
      throw new AdeError(
        "permission",
        "The authenticated GitHub identity changed since manual approval.",
      );

    const log = await this.git(cwd, [
      "log",
      "--format=%H%x00%P%x00%s",
      `${session.workspace.original_head}..${head}`,
      "--",
    ]);

    const publication: RepairPublication = {
      id: randomUUID(),
      repair_id: session.id,
      pr_url: fresh.url,
      destination: {
        repository: fresh.head.name,
        repository_id: fresh.head.id,
        url: fresh.head.url,
        branch: fresh.head.branch,
      },
      expected_remote_head: remote,
      local_head: head,
      fingerprint,
      upstream_base: {
        branch: fresh.base.branch,
        sha: session.workspace.fetched_base,
      },
      dirty: !!(await this.git(cwd, ["status", "--porcelain", "--untracked-files=all"])),
      changes: {
        files: diff.files.length,
        additions: diff.insertions,
        deletions: diff.deletions,
      },
      validation: {
        observed_passed: tests.filter((t) => t.status === "passed").length,
        observed_failed: tests.filter((t) => t.status === "failed").length,
        reported_blocked: [
          ...(session.implementation?.tests || []),
          ...(session.verification?.tests || []),
        ].filter((t) => ["blocked", "not_run"].includes(t.status)).length,
      },
      commits: log
        ? log.split("\n").map((line) => {
            const [sha, parents, subject] = line.split("\0");
            return { sha, parents, subject };
          })
        : [],
      confirmation: { ...confirmation, confirmed_at: null },
      outcome: "prepared",
      error: null,
      created_at: now(),
      updated_at: now(),
      published_at: null,
    };

    this.save(publication);
    return publication;
  };

  private validateIdentity = (session: RepairSession, fresh: PRIdentity) => {
    const identity = session.identity;
    if (fresh.state !== "open") throw new AdeError("pr_closed", "The PR is no longer open.");
    if (
      fresh.id !== identity.id ||
      fresh.upstream.id !== identity.upstream.id ||
      fresh.head.id !== identity.head.id ||
      fresh.head.name !== identity.head.name ||
      fresh.head.url !== identity.head.url ||
      fresh.head.branch !== identity.head.branch ||
      fresh.base.branch !== identity.base.branch
    )
      throw new AdeError("pr_identity", "Publication destination or PR identity changed.");
  };

  pushConfirmed = async (session: RepairSession, id: string, signal: AbortSignal) => {
    const publication = this.get(session.id, id);
    if (publication.outcome === "published") return publication;
    if (
      publication.outcome !== "prepared" ||
      session.status !== "ready_to_publish" ||
      publication.dirty
    )
      throw new AdeError(
        "manual_review",
        "Prepare and confirm a clean, committed publication before pushing.",
      );
    const cwd = await this.workspace(session);
    const fingerprint = await this.engine.git.repairFingerprint(repairAssignment(session));
    if (
      fingerprint !== publication.fingerprint ||
      fingerprint !== session.approved_hash ||
      (await this.git(cwd, ["rev-parse", "HEAD"])) !== publication.local_head ||
      (await this.git(cwd, ["status", "--porcelain", "--untracked-files=all"]))
    )
      throw new AdeError(
        "review_changed",
        "The approved local commit, index or workspace changed after publication was prepared.",
      );
    const fresh = await this.readIdentity(session.identity.url, signal);
    this.validateIdentity(session, fresh);
    if (!fresh.can_push || fresh.viewer !== publication.confirmation.viewer)
      throw new AdeError("permission", "Publishing permission or authenticated identity changed.");
    const destination = this.transport?.(fresh) ?? fresh.head.url;
    // Reject repository-config URL rewrites rather than sending to a different host.
    if ((await this.git(cwd, ["ls-remote", "--get-url", "--", destination])) !== destination)
      throw new AdeError(
        "pr_identity",
        "Git URL rewriting changed the intended publication destination.",
      );
    if (
      fresh.head.sha !== publication.expected_remote_head ||
      (await this.workspaces.remoteHead(fresh, cwd, signal)) !== publication.expected_remote_head
    )
      throw new AdeError("stale_remote_head", "Remote PR head changed before push confirmation.");
    if (
      (
        await gitCapture(
          ["merge-base", "--is-ancestor", publication.expected_remote_head, publication.local_head],
          cwd,
        )
      ).code !== 0 ||
      (
        await gitCapture(
          ["merge-base", "--is-ancestor", publication.upstream_base.sha, publication.local_head],
          cwd,
        )
      ).code !== 0
    )
      throw new AdeError(
        "ancestry",
        "The approved publication is not a normal fast-forward descendant.",
      );
    const hooks = await managedPath(this.engine.root, join("artifacts", `push-${publication.id}`));
    await mkdir(hooks, { mode: 0o700 });
    const guard = await managedPath(this.engine.root, join(hooks, "pre-push"));

    const expected = {
      destination,
      ref: `refs/heads/${publication.destination.branch}`,
      remote: publication.expected_remote_head,
      local: publication.local_head,
    };

    await writeFile(
      guard,
      `#!${process.execPath}\nconst expected=${JSON.stringify(expected)};let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const rows=input.trim().split('\\n').filter(Boolean).map(line=>line.split(/\\s+/));if(process.argv[3]!==expected.destination||rows.length!==1||rows[0][1]!==expected.local||rows[0][2]!==expected.ref||rows[0][3]!==expected.remote){process.stderr.write('Remote head or publication destination changed during push; rejected.\\n');process.exitCode=1;}});\n`,
      { mode: 0o700 },
    );

    await chmod(guard, 0o700);
    publication.outcome = "pushing";
    publication.confirmation.confirmed_at = now();
    this.save(publication);
    let sending = true;
    try {
      const result = await publishFastForward(
        {
          allowLocalTransport: !!this.transport,
          hooksPath: hooks,
          destination,
          branch: publication.destination.branch,
          expectedRemote: publication.expected_remote_head,
          localHead: publication.local_head,
          cwd,
          signal,
          onSpawn: (pid, identity) => {
            if (!sending || !identity) return;
            publication.pid = pid;
            publication.process_identity = identity;
            this.save(publication);
          },
        },
        this.push,
      );

      sending = false;
      if (result.code !== 0) publication.error = redact(result.stderr || result.stdout);
      this.save(publication);
      const reconciled = await this.reconcile(session, publication.id);
      if (reconciled.outcome !== "published" && !reconciled.error) {
        reconciled.error =
          "Push did not reach the approved remote head; inspect publication history.";

        this.save(reconciled);
      }

      return reconciled;
    } catch (error) {
      sending = false;
      publication.outcome = "uncertain";
      publication.error = redact(String(error));
      this.save(publication);
      return this.reconcile(session, publication.id);
    } finally {
      sending = false;

      await rm(await managedPath(this.engine.root, hooks), {
        recursive: true,
        force: true,
      });
    }
  };

  reconcile = async (session: RepairSession, id: string) => {
    const publication = this.get(session.id, id);
    if (!["pushing", "uncertain"].includes(publication.outcome)) return publication;
    try {
      const cwd = await this.workspace(session);

      const remote = await this.workspaces.remoteHead(
        session.identity,
        cwd,
        AbortSignal.timeout(60000),
      );

      if (remote === publication.local_head) {
        publication.outcome = "published";
        publication.published_at = now();
        this.store.transition(session, "published");
      } else if (remote === publication.expected_remote_head) publication.outcome = "not_published";
      else {
        publication.outcome = "stale_remote_head";

        this.store.transition(
          session,
          "stale_remote_head",
          "Remote head changed during publication. Analyze the PR explicitly before further work.",
        );
      }
    } catch (error) {
      publication.outcome = "uncertain";
      publication.error = redact(String(error));
    }

    this.save(publication);
    this.engine.publish({ event: "changed", repair_id: session.id });
    return publication;
  };
}
