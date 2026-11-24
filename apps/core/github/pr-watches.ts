import { randomUUID } from "node:crypto";
import { z } from "zod";

import { AdeError, now } from "../domain";
import type { Database } from "../storage/database";
import { type ViberMessage, ViberMessageSchema } from "../vibers/contracts";
import type { GitHubClient } from "./client";
import {
  canonicalPullRequest,
  type CanonicalPullRequestRef,
  type PrWatchCursor,
  type PrWatchRecord,
  type WatchCommand,
} from "./contracts";

export interface PrWatchHost {
  db: Database;
  changed: () => void;
  root: string;
}

export interface GitHubPullRequestDetails {
  url: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  headRefOid: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  commits?: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup?: {
          state: string;
        } | null;
      };
    }>;
  } | null;
}

const prResponseSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              url: z.string(),
              number: z.number().int().positive(),
              title: z.string(),
              state: z.enum(["OPEN", "CLOSED", "MERGED"]),
              isDraft: z.boolean(),
              updatedAt: z.string(),
              headRefName: z.string(),
              headRefOid: z.string(),
              mergeable: z
                .enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"])
                .optional()
                .default("UNKNOWN"),
              reviewDecision: z
                .enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"])
                .nullable()
                .optional()
                .default(null),
              commits: z
                .object({
                  nodes: z.array(
                    z.object({
                      commit: z.object({
                        oid: z.string(),
                        statusCheckRollup: z
                          .object({
                            state: z.string(),
                          })
                          .nullable()
                          .optional(),
                      }),
                    }),
                  ),
                })
                .nullable()
                .optional(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .optional(),
  errors: z.array(z.unknown()).optional(),
});

export const compareCursors = (previous: PrWatchCursor, current: PrWatchCursor): string[] => {
  const changes: string[] = [];

  // Lifecycle transitions
  if (previous.state === "OPEN" && current.state === "MERGED") {
    changes.push("Merged into base branch");
  } else if (previous.state === "OPEN" && current.state === "CLOSED") {
    changes.push("Closed without merge");
  } else if (previous.state !== "OPEN" && current.state === "OPEN") {
    changes.push("Reopened");
  }

  // Draft transition
  if (previous.draft && !current.draft) {
    changes.push("Marked ready for review");
  }

  // Review decision transitions
  if (previous.review_decision !== current.review_decision) {
    if (current.review_decision === "APPROVED") {
      changes.push("Reviews approved");
    } else if (current.review_decision === "CHANGES_REQUESTED") {
      changes.push("Changes requested by reviewer");
    } else if (
      current.review_decision === "REVIEW_REQUIRED" &&
      previous.review_decision === "CHANGES_REQUESTED"
    ) {
      changes.push("Review requested (changes addressed)");
    }
  }

  // Checks transitions (tied to current head commit)
  if (previous.check_status !== current.check_status) {
    if (current.check_status === "SUCCESS") {
      changes.push("All checks passed");
    } else if (current.check_status === "FAILURE" || current.check_status === "ERROR") {
      changes.push("Checks failed");
    } else if (
      current.check_status === "PENDING" &&
      (previous.check_status === "FAILURE" || previous.check_status === "ERROR")
    ) {
      changes.push("Checks re-running (pending)");
    }
  }

  // Merge conflicts (UNKNOWN never implies resolved or conflicting)
  if (previous.mergeable !== current.mergeable) {
    if (current.mergeable === "CONFLICTING") {
      changes.push("Merge conflict detected");
    } else if (previous.mergeable === "CONFLICTING" && current.mergeable === "MERGEABLE") {
      changes.push("Merge conflict resolved");
    }
  }

  return changes;
};

export class PrWatchService {
  private readonly inFlight = new Map<string, AbortController>();

  private timer: ReturnType<typeof setInterval> | null = null;

  private stopping = false;

  private activePoll: Promise<void> | null = null;

  constructor(
    private readonly host: PrWatchHost,
    private readonly client: GitHubClient,
    private readonly pollIntervalMs = 60000,
  ) {}

  start = () => {
    if (this.timer || this.stopping) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
  };

  close = async () => {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const controller of this.inFlight.values()) {
      controller.abort();
    }

    this.inFlight.clear();

    if (this.activePoll) {
      try {
        await this.activePoll;
      } catch {
        /* Shutdown ignores in-flight poll errors */
      }
    }
  };

  cancelForProfile = (profileId: string) => {
    const timestamp = now();

    const watches = this.host.db.all<{ id: string }>(
      `SELECT w.id FROM viber_pr_watches w
       JOIN viber_sessions s ON s.id=w.session_id
       WHERE s.profile_id=? AND w.status='active'`,
      profileId,
    );

    for (const watch of watches) {
      const controller = this.inFlight.get(watch.id);
      if (controller) {
        controller.abort();
        this.inFlight.delete(watch.id);
      }
    }

    if (watches.length > 0) {
      this.host.db.run(
        `UPDATE viber_pr_watches SET status='cancelled', updated_at=?
         WHERE status='active' AND session_id IN (
           SELECT id FROM viber_sessions WHERE profile_id=?
         )`,
        timestamp,
        profileId,
      );
    }
  };

  fetchPullRequest = async (
    ref: CanonicalPullRequestRef,
    signal?: AbortSignal,
  ): Promise<{ pr: GitHubPullRequestDetails; cursor: PrWatchCursor }> => {
    const query = `query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: ${ref.number}) {
          url
          number
          title
          state
          isDraft
          updatedAt
          headRefName
          headRefOid
          mergeable
          reviewDecision
          commits(last: 1) {
            nodes {
              commit {
                oid
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }`;

    const raw = await this.client.graphql(query, { owner: ref.owner, repo: ref.repo }, signal);
    const parsed = prResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AdeError("github", "GitHub returned malformed pull request data");
    }

    if (parsed.data.errors?.length && !parsed.data.data?.repository?.pullRequest) {
      throw new AdeError(
        "github",
        `GitHub GraphQL error: ${JSON.stringify(parsed.data.errors[0])}`,
      );
    }

    const pr = parsed.data.data?.repository?.pullRequest;
    if (!pr) {
      throw new AdeError(
        "not_found",
        `Pull request #${ref.number} was not found in ${ref.owner}/${ref.repo}`,
      );
    }

    // Verify response matches requested PR
    const canonicalReturned = canonicalPullRequest(pr.url);
    if (
      canonicalReturned.owner !== ref.owner ||
      canonicalReturned.repo !== ref.repo ||
      canonicalReturned.number !== ref.number
    ) {
      throw new AdeError("github", "GitHub returned metadata for an unexpected pull request");
    }

    const lastCommit = pr.commits?.nodes?.[0]?.commit;

    const checkStatus =
      lastCommit && lastCommit.oid === pr.headRefOid
        ? (lastCommit.statusCheckRollup?.state ?? null)
        : null;

    const cursor: PrWatchCursor = {
      state: pr.state,
      draft: pr.isDraft,
      head_sha: pr.headRefOid,
      review_decision: pr.reviewDecision,
      check_status: checkStatus,
      mergeable: pr.mergeable,
      updated_at: pr.updatedAt,
    };

    return { pr, cursor };
  };

  handleChatCommand = async (
    sessionId: string,
    profileId: string,
    requestId: string,
    content: string,
    command: WatchCommand,
  ): Promise<ViberMessage> => {
    // Assert session exists
    const session = this.host.db.all<{ id: string }>(
      "SELECT id FROM viber_sessions WHERE id=? AND profile_id=?",
      sessionId,
      profileId,
    )[0];

    if (!session) {
      throw new AdeError("not_found", "Viber session not found");
    }

    let replyText: string;

    switch (command.type) {
      case "create": {
        replyText = await this.createWatch(sessionId, command.url);
        break;
      }

      case "list": {
        replyText = this.listWatches(sessionId);
        break;
      }

      case "cancel": {
        replyText = this.cancelWatch(sessionId, command.target);
        break;
      }

      case "help": {
        replyText =
          command.message ||
          [
            "**PR Watch Commands**",
            "• `/watch <url>` — Watch a pull request for review, check, conflict, and lifecycle changes",
            "• `/watch list` (or `/watches`) — List active PR watches in this session",
            "• `/watch cancel <url | id>` (or `/unwatch <url | id>`) — Stop watching a pull request",
          ].join("\n");

        break;
      }
    }

    const timestamp = now();
    const assistantMessageId = randomUUID();

    this.host.db.transaction(() => {
      this.host.db.run(
        "INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects) VALUES(?,?,'user',?,'completed',?,?,'none')",
        requestId,
        sessionId,
        content,
        JSON.stringify({ kind: "pr_watch", command: true }),
        timestamp,
      );

      this.host.db.run(
        "INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects) VALUES(?,?,'assistant',?,'completed',?,?,'none')",
        assistantMessageId,
        sessionId,
        replyText,
        JSON.stringify({ kind: "pr_watch", command: false }),
        timestamp,
      );
    });

    this.host.changed();

    const row = this.host.db.all(
      "SELECT *,json_extract(configuration,'$.continue_message_id') AS continue_message_id FROM viber_messages WHERE id=?",
      requestId,
    )[0];

    return ViberMessageSchema.parse(row);
  };

  createWatch = async (sessionId: string, rawUrl: string): Promise<string> => {
    let canonical: CanonicalPullRequestRef;
    try {
      canonical = canonicalPullRequest(rawUrl);
    } catch {
      return "Invalid PR URL. Please use an HTTPS github.com/owner/repository/pull/number URL.";
    }

    // Check if duplicate watch is already active for this session
    const existing = this.host.db.all<{
      id: string;
      pull_number: number;
      owner: string;
      repo: string;
    }>(
      `SELECT id, pull_number, owner, repo FROM viber_pr_watches
       WHERE session_id=? AND lower(owner)=? AND lower(repo)=? AND pull_number=? AND status='active'`,
      sessionId,
      canonical.owner,
      canonical.repo,
      canonical.number,
    )[0];

    if (existing) {
      return `Already watching PR #${canonical.number} (${canonical.owner}/${canonical.repo}).`;
    }

    // Fetch initial baseline state
    let prData;
    try {
      prData = await this.fetchPullRequest(canonical);
    } catch (error) {
      return `Cannot watch PR ${canonical.url}: ${error instanceof Error ? error.message : String(error)}`;
    }

    const { pr, cursor } = prData;
    const watchId = randomUUID();
    const timestamp = now();
    const terminal = pr.state !== "OPEN";
    const initialStatus = terminal ? "completed" : "active";

    try {
      this.host.db.run(
        `INSERT INTO viber_pr_watches(id,session_id,url,owner,repo,pull_number,title,status,cursor,last_checked_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        watchId,
        sessionId,
        canonical.url,
        canonical.owner,
        canonical.repo,
        canonical.number,
        pr.title,
        initialStatus,
        JSON.stringify(cursor),
        timestamp,
        timestamp,
        timestamp,
      );
    } catch (error) {
      return `Could not register watch: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (terminal) {
      return `PR #${canonical.number} (${canonical.owner}/${canonical.repo}) is already ${pr.state.toLowerCase()} ("${pr.title}"). Initial state recorded; no active notifications scheduled.`;
    }

    return `Watching PR #${canonical.number} (${canonical.owner}/${canonical.repo}): "${pr.title}" [OPEN]. You'll be notified of review, check, conflict, or lifecycle changes.`;
  };

  listWatches = (sessionId: string): string => {
    const watches = this.host.db.all<PrWatchRecord>(
      `SELECT * FROM viber_pr_watches WHERE session_id=? AND status='active' ORDER BY pull_number ASC`,
      sessionId,
    );

    if (watches.length === 0) {
      return "No active PR watches in this session. Use `/watch <pr-url>` to watch a pull request.";
    }

    const lines = ["**Active PR watches in this session:**"];
    for (const w of watches) {
      let stateLabel = "OPEN";
      if (w.cursor) {
        try {
          const parsed = JSON.parse(w.cursor) as PrWatchCursor;
          stateLabel = parsed.state;
        } catch {
          /* ignore */
        }
      }

      lines.push(
        `• **#${w.pull_number}** (${w.owner}/${w.repo}): "${w.title || `PR #${w.pull_number}`}" [${stateLabel}]\n  URL: ${w.url}\n  ID: \`${w.id}\``,
      );
    }

    return lines.join("\n");
  };

  cancelWatch = (sessionId: string, target: string): string => {
    let watch: PrWatchRecord | undefined;

    // Try parsing as canonical PR URL
    try {
      const canonical = canonicalPullRequest(target);

      watch = this.host.db.all<PrWatchRecord>(
        `SELECT * FROM viber_pr_watches
         WHERE session_id=? AND lower(owner)=? AND lower(repo)=? AND pull_number=? AND status='active'`,
        sessionId,
        canonical.owner,
        canonical.repo,
        canonical.number,
      )[0];
    } catch {
      // Not a URL; try UUID or #number
    }

    if (!watch) {
      // Try ID match
      watch = this.host.db.all<PrWatchRecord>(
        `SELECT * FROM viber_pr_watches WHERE session_id=? AND id=? AND status='active'`,
        sessionId,
        target.trim(),
      )[0];
    }

    if (!watch) {
      // Try number match like "#123" or "123"
      const numMatch = target.trim().match(/^#?([1-9]\d*)$/);
      if (numMatch) {
        watch = this.host.db.all<PrWatchRecord>(
          `SELECT * FROM viber_pr_watches WHERE session_id=? AND pull_number=? AND status='active'`,
          sessionId,
          Number(numMatch[1]),
        )[0];
      }
    }

    if (!watch) {
      return `No active watch found for "${target}" in this session.`;
    }

    const timestamp = now();

    // 1. Cancel in DB immediately
    this.host.db.run(
      `UPDATE viber_pr_watches SET status='cancelled', updated_at=? WHERE id=?`,
      timestamp,
      watch.id,
    );

    // 2. Abort any in-flight request
    const controller = this.inFlight.get(watch.id);
    if (controller) {
      controller.abort();
      this.inFlight.delete(watch.id);
    }

    return `Stopped watching PR #${watch.pull_number} (${watch.owner}/${watch.repo}).`;
  };

  pollAll = async (signal?: AbortSignal): Promise<void> => {
    if (this.stopping || signal?.aborted) {
      return;
    }

    const run = (async () => {
      const activeWatches = this.host.db.all<PrWatchRecord>(
        `SELECT w.* FROM viber_pr_watches w
         JOIN viber_sessions s ON s.id=w.session_id
         LEFT JOIN retired_viber_profiles r ON r.profile_id=s.profile_id
         WHERE w.status='active' AND r.profile_id IS NULL
         ORDER BY w.updated_at ASC`,
      );

      for (const watch of activeWatches) {
        if (this.stopping || signal?.aborted) {
          break;
        }

        await this.pollWatch(watch, signal);
      }
    })();

    this.activePoll = run;
    try {
      await run;
    } finally {
      if (this.activePoll === run) {
        this.activePoll = null;
      }
    }
  };

  pollWatch = async (watch: PrWatchRecord, signal?: AbortSignal): Promise<void> => {
    if (this.stopping || signal?.aborted) {
      return;
    }

    const controller = new AbortController();

    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    this.inFlight.set(watch.id, controller);

    try {
      const canonical: CanonicalPullRequestRef = {
        owner: watch.owner,
        repo: watch.repo,
        number: watch.pull_number,
        url: watch.url,
      };

      const { pr, cursor: newCursor } = await this.fetchPullRequest(canonical, combinedSignal);

      // Check if watch was cancelled or profile retired in-flight
      if (controller.signal.aborted || this.stopping) {
        return;
      }

      let oldCursor: PrWatchCursor | null = null;
      if (watch.cursor) {
        try {
          oldCursor = JSON.parse(watch.cursor) as PrWatchCursor;
        } catch {
          oldCursor = null;
        }
      }

      const timestamp = now();
      const changes = oldCursor ? compareCursors(oldCursor, newCursor) : [];
      const isTerminal = newCursor.state === "MERGED" || newCursor.state === "CLOSED";
      const nextStatus = isTerminal ? "completed" : "active";

      this.host.db.transaction(() => {
        // Assert watch is still active and profile is not retired
        const current = this.host.db.all<PrWatchRecord>(
          `SELECT w.* FROM viber_pr_watches w
           JOIN viber_sessions s ON s.id=w.session_id
           LEFT JOIN retired_viber_profiles r ON r.profile_id=s.profile_id
           WHERE w.id=? AND w.status='active' AND r.profile_id IS NULL`,
          watch.id,
        )[0];

        if (!current) {
          // Cancelled or retired in-flight; drop result!
          return;
        }

        // If changes detected, insert notification message into viber_messages
        if (changes.length > 0) {
          const reportText = [
            `**[PR Watch] #${watch.pull_number} (${watch.owner}/${watch.repo})**`,
            ...changes.map((change) => `• ${change}`),
          ].join("\n");

          this.host.db.run(
            `INSERT INTO viber_messages(id,session_id,role,content,status,configuration,created_at,effects)
             VALUES(?,?,'assistant',?,'completed',?,?,'none')`,
            randomUUID(),
            watch.session_id,
            reportText,
            JSON.stringify({ kind: "pr_watch", command: false, watch_id: watch.id }),
            timestamp,
          );
        }

        // Commit new cursor and status together
        this.host.db.run(
          `UPDATE viber_pr_watches
           SET cursor=?, title=?, last_checked_at=?, status=?, error=NULL, updated_at=?
           WHERE id=? AND status='active'`,
          JSON.stringify(newCursor),
          pr.title,
          timestamp,
          nextStatus,
          timestamp,
          watch.id,
        );
      });

      if (changes.length > 0) {
        this.host.changed();
      }
    } catch (error) {
      if (controller.signal.aborted || this.stopping) {
        return;
      }

      const timestamp = now();
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Record error on watch row without spamming chat or modifying cursor
      this.host.db.run(
        `UPDATE viber_pr_watches SET error=?, updated_at=? WHERE id=? AND status='active'`,
        errorMessage,
        timestamp,
        watch.id,
      );
    } finally {
      this.inFlight.delete(watch.id);
    }
  };
}
