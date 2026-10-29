import { z } from "zod";

import { AdeError } from "../domain";
import { parsePullRequest } from "../scheduled/contracts";
import type { GitHubPullRequest } from "./contracts";

const fields = `url number title state isDraft updatedAt headRefName headRefOid
  headRepository { nameWithOwner } repository { nameWithOwner }`;

const metadataSchema = z.object({
  url: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
  repository: z.object({ nameWithOwner: z.string() }),
});

type Query = (query: string, variables: Record<string, string>) => Promise<unknown>;

const metadata = (input: unknown): GitHubPullRequest => {
  const value = metadataSchema.parse(input);
  const ref = parsePullRequest(value.url);
  if (
    value.number !== ref.number ||
    value.repository.nameWithOwner.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()
  )
    throw new AdeError("github", "GitHub returned inconsistent PR metadata");

  return {
    url: ref.url,
    repository: value.repository.nameWithOwner,
    number: value.number,
    title: value.title,
    state: value.state,
    draft: value.isDraft,
    head_sha: value.headRefOid,
    head_branch: value.headRefName,
    head_repository: value.headRepository?.nameWithOwner || null,
    updated_at: value.updatedAt,
    task_id: null,
  };
};

const pageSchema = z.object({
  data: z.object({
    search: z.object({
      issueCount: z.number().int().nonnegative(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(metadataSchema),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

/** Lifecycle discovery returns metadata in the search itself, without per-PR REST reads. */
export const authoredPullRequests = async (username: string, query: Query) => {
  if (!/^[a-z\d-]{1,39}$/i.test(username))
    throw new AdeError("github", "GitHub returned an invalid account login");
  let requests = 0;

  const search = async (from: number, until: number): Promise<GitHubPullRequest[]> => {
    const rows: GitHubPullRequest[] = [];
    const cursors = new Set<string>();
    let cursor = "";
    let count: number | undefined;
    do {
      if (++requests > 200)
        throw new AdeError(
          "github",
          "Authored PR search exceeded its request budget; saved results remain.",
        );

      const result = pageSchema.parse(
        await query(
          `query($search: String!, $cursor: String) {
          search(type: ISSUE, query: $search, first: 100, after: $cursor) {
            issueCount pageInfo { hasNextPage endCursor }
            nodes { ... on PullRequest { ${fields} } }
          }
        }`,
          {
            search: `is:pr author:${username} created:${new Date(from).toISOString()}..${new Date(until).toISOString()}`,
            ...(cursor ? { cursor } : {}),
          },
        ),
      );

      if (result.errors?.length)
        throw new AdeError("github", "GitHub returned incomplete PR results; retry refresh");
      const page = result.data.search;
      if (page.issueCount > 1000) {
        const mid = Math.floor((from + until) / 2000) * 1000;
        if (mid <= from)
          throw new AdeError(
            "github",
            "More than 1,000 PRs in one second; discovery is incomplete",
          );
        return [...(await search(from, mid)), ...(await search(mid + 1000, until))];
      }

      count ??= page.issueCount;
      if (page.issueCount !== count)
        throw new AdeError("github", "GitHub PR results changed during pagination; retry refresh");
      rows.push(...page.nodes.map(metadata));
      if (!page.pageInfo.hasNextPage) break;
      const next = page.pageInfo.endCursor;
      if (!next || cursors.has(next))
        throw new AdeError("github", "GitHub PR pagination did not advance; saved results remain");
      cursors.add(next);
      cursor = next;
    } while (cursor);

    if (new Set(rows.map((row) => row.url)).size !== count || rows.length !== count)
      throw new AdeError("github", "GitHub PR results were truncated or duplicated; retry refresh");
    return rows;
  };

  return [
    ...new Map((await search(Date.UTC(2008, 0, 1), Date.now())).map((pr) => [pr.url, pr])).values(),
  ];
};

/** Search absence never proves closure; known PRs are rechecked in bounded batches. */
export const knownPullRequests = async (urls: string[], query: Query) => {
  const rows: GitHubPullRequest[] = [];
  for (let offset = 0; offset < urls.length; offset += 25) {
    const batch = urls.slice(offset, offset + 25).map(parsePullRequest);

    const result = z
      .object({
        data: z.record(z.string(), z.object({ pullRequest: metadataSchema.nullable() }).nullable()),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(
        await query(
          `query { ${batch
            .map(
              (ref, index) =>
                `p${index}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) {
        pullRequest(number: ${ref.number}) { ${fields} }
      }`,
            )
            .join("\n")} }`,
          {},
        ),
      );

    if (result.errors?.length)
      throw new AdeError("github", "GitHub could not retrieve all known PR metadata");
    for (const [index, ref] of batch.entries()) {
      const value = result.data[`p${index}`]?.pullRequest;
      if (!value)
        throw new AdeError("github", `Cannot access ${ref.url}; its lifecycle is unknown`);
      const pr = metadata(value);
      if (pr.url.toLowerCase() !== ref.url.toLowerCase())
        throw new AdeError("github", "GitHub returned metadata for a different PR");
      rows.push(pr);
    }
  }

  return rows;
};
