import { z } from "zod";

import { AdeError } from "../domain";
import type { ScheduleTask } from "../vibers/schedule-contracts";
import type { GitHubClient } from "./client";
import { canonicalPullRequest, type CanonicalPullRequestRef } from "./contracts";

interface PrWatchCursor {
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  head_sha: string;
  review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  check_status: string | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

const prResponseSchema = z.object({
  data: z
    .object({
      viewer: z.object({ login: z.string() }),
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

const compareCursors = (previous: PrWatchCursor, current: PrWatchCursor): string[] => {
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

const fetchPullRequest = async (
  client: GitHubClient,
  ref: CanonicalPullRequestRef,
  account: string,
  signal: AbortSignal,
) => {
    const query = `query($owner: String!, $repo: String!) {
      viewer { login }
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

    const raw = await client.graphql(query, { owner: ref.owner, repo: ref.repo }, signal);
    const parsed = prResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AdeError("github", "GitHub returned malformed pull request data");
    }

    if (parsed.data.errors?.length) {
      throw new AdeError(
        "github",
        "GitHub could not retrieve complete PR details.",
      );
    }

    if (parsed.data.data?.viewer.login.toLowerCase() !== account) {
      throw new AdeError("github_account", "GitHub account changed during the PR check.");
    }
    const pr = parsed.data.data.repository?.pullRequest;
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
    };

    return cursor;
  };

type AttentionReason = "Review requested" | "Changes requested";
type GitHubCursor = { pull: PrWatchCursor } | { attention: string[] };

const searchPage = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    search: z.object({
      issueCount: z.number().int().nonnegative().max(1000),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(z.object({ url: z.string() })),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

const searchForAttention = async (
  client: GitHubClient,
  query: string,
  account: string,
  signal: AbortSignal,
) => {
  const urls = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let count: number | undefined;
  for (let page = 0; page < 10; page++) {
    const result = searchPage.parse(await client.graphql(
      `query($search: String!, $cursor: String) {
        viewer { login }
        search(type: ISSUE, query: $search, first: 100, after: $cursor) {
          issueCount
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest { url } }
        }
      }`,
      { search: `is:pr is:open draft:false ${query}`, ...(cursor ? { cursor } : {}) },
      signal,
    ));
    if (result.data.viewer.login.toLowerCase() !== account) {
      throw new AdeError("github_account", "GitHub account changed during the PR check.");
    }
    const { issueCount, pageInfo, nodes } = result.data.search;
    count ??= issueCount;
    if (result.errors?.length || count !== issueCount) {
      break;
    }

    for (const row of nodes) {
      const { url } = canonicalPullRequest(row.url);
      if (urls.has(url)) {
        throw new AdeError("github", "GitHub returned duplicate PRs. The watch will retry.");
      }
      urls.add(url);
    }
    if (!pageInfo.hasNextPage && urls.size === issueCount) {
      return urls;
    }
    cursor = pageInfo.endCursor;
    if (!pageInfo.hasNextPage || !cursor || cursors.has(cursor)) {
      break;
    }
    cursors.add(cursor);
  }
  throw new AdeError("github", "GitHub returned an incomplete list of PRs. The watch will retry.");
};

export const checkScheduledPullRequests = async (
  client: GitHubClient,
  task: Extract<ScheduleTask, { kind: "github" }>,
  account: string,
  previous: string | null,
  signal: AbortSignal,
): Promise<{ cursor: string; message?: string; completed?: boolean }> => {
  const before: GitHubCursor | null = previous ? JSON.parse(previous) : null;
  if (task.pull) {
    const ref = canonicalPullRequest(task.pull);
    const cursor = await fetchPullRequest(client, ref, account, signal);
    const prior = before && "pull" in before ? before.pull : undefined;
    if (prior && cursor.mergeable === "UNKNOWN") {
      cursor.mergeable = prior.mergeable;
    }
    if (prior?.head_sha === cursor.head_sha && !cursor.check_status) {
      cursor.check_status = prior.check_status;
    }
    const changes = prior ? compareCursors(prior, cursor) : [];
    const completed = cursor.state !== "OPEN";
    if (completed && !before) {
      changes.push(cursor.state === "MERGED" ? "Already merged" : "Already closed");
    }
    return {
      cursor: JSON.stringify({ pull: cursor }),
      completed,
      message: changes.length
        ? `**[PR #${ref.number} · ${ref.owner}/${ref.repo}](${ref.url})**\n\n${changes.map((change) => `- ${change}`).join("\n")}`
        : undefined,
    };
  }

  if (!/^[a-z\d-]{1,39}$/i.test(account)) {
    throw new AdeError("github", "GitHub returned an invalid account login.");
  }

  const repo = task.repository ? ` repo:${task.repository}` : "";
  const matches = new Map<string, AttentionReason>();
  for (const url of await searchForAttention(client, `review-requested:${account}${repo}`, account, signal)) {
    matches.set(url, "Review requested");
  }
  for (const url of await searchForAttention(client, `author:${account} review:changes_requested${repo}`, account, signal)) {
    matches.set(url, "Changes requested");
  }

  // Persist only actionable state. Search order, titles, comments, and timestamps cannot trigger a post.
  const keys = [...matches].map(([url, reason]) => `${reason} ${url}`).sort();
  const seen = new Set(before && "attention" in before ? before.attention : []);
  const changes = keys.filter((key) => !seen.has(key));
  return {
    cursor: JSON.stringify({ attention: keys }),
    message: changes.length
      ? `**PRs that need your attention**\n\n${changes.map((key) => {
          const offset = key.indexOf(" https://");
          const reason = key.slice(0, offset);
          const url = key.slice(offset + 1);
          const ref = canonicalPullRequest(url);
          return `- ${reason} — [${ref.owner}/${ref.repo} #${ref.number}](${url})`;
        }).join("\n")}`
      : undefined,
  };
};
