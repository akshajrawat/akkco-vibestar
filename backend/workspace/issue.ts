import { AdeError, now, type IssueRef } from "../domain";
import { GitHubClient } from "../github/client";
import { object } from "../execution/providers/contracts";

export const fetchIssue = async (
  reference: IssueRef,
  cwd: string,
  signal?: AbortSignal,
) => {
  const client = new GitHubClient(cwd);
  // Authenticated CLI GETs first; public REST is a credential-free fallback.
  const get = async (endpoint: string): Promise<unknown> => {
    try {
      return await client.api(endpoint, signal);
    } catch {
      signal?.throwIfAborted();
      const response = await fetch(`https://api.github.com/${endpoint}`, {
        headers: {
          "User-Agent": "akkco-vibestar/0.1",
          Accept: "application/vnd.github+json",
        },
        signal: signal || AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new AdeError(
          "github",
          `GitHub context retrieval returned ${response.status}. Connect GitHub in the configured WSL distribution and retry.`,
        );
      return response.json();
    }
  };
  const pages = async (endpoint: string) => {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page++) {
      const part = await get(`${endpoint}?per_page=100&page=${page}`);
      if (!Array.isArray(part))
        throw new AdeError(
          "github",
          "Unexpected issue context pagination response",
        );
      rows.push(...part.map(object));
      if (part.length < 100) return rows;
    }
    throw new AdeError(
      "github",
      "Issue context exceeds the 10,000-entry pagination limit; no incomplete issue context was accepted.",
    );
  };
  const base = `repos/${reference.owner}/${reference.repo}/issues/${reference.number}`;
  const issue = object(await get(base));
  if (issue.pull_request)
    throw new AdeError(
      "invalid_input",
      "URL identifies a pull request, not an issue",
    );
  const comments = await pages(`${base}/comments`);
  const warnings: string[] = [];
  let timeline: Record<string, unknown>[] = [];
  try {
    timeline = await pages(`${base}/timeline`);
  } catch (error) {
    signal?.throwIfAborted();
    warnings.push(
      `Linked PR timeline unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const links = new Set<string>();
  for (const text of [
    issue.body,
    ...comments.map((c) => c.body),
    ...timeline.map((e) => object(object(e.source).issue).html_url),
  ]) {
    for (const match of String(text || "").matchAll(
      /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g,
    ))
      links.add(`${match[1]}/${match[2]}/${match[3]}`);
  }
  const linkedPullRequests: Record<string, unknown>[] = [];
  for (const link of [...links].slice(0, 20)) {
    const [owner, repo, number] = link.split("/");
    const endpoint = `repos/${owner}/${repo}`;
    try {
      const pr = object(await get(`${endpoint}/pulls/${number}`));
      linkedPullRequests.push({
        url: pr.html_url,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        author: object(pr.user).login,
        base: object(pr.base).ref,
        head: object(pr.head).ref,
        comments: await pages(`${endpoint}/issues/${number}/comments`),
        reviews: await pages(`${endpoint}/pulls/${number}/reviews`),
        reviewComments: await pages(`${endpoint}/pulls/${number}/comments`),
        files: (await pages(`${endpoint}/pulls/${number}/files`)).map((f) => ({
          filename: f.filename,
          status: f.status,
          previous_filename: f.previous_filename,
          additions: f.additions,
          deletions: f.deletions,
        })),
      });
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(
        `Linked PR ${owner}/${repo}#${number} could not be fully retrieved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (links.size > 20)
    warnings.push(
      `${links.size - 20} linked PRs omitted by the 20-PR context limit.`,
    );
  return {
    title: issue.title,
    body: issue.body,
    comments,
    labels: issue.labels,
    state: issue.state,
    url: reference.url,
    number: reference.number,
    linkedPullRequests,
    contextWarnings: warnings,
    context_fetched_at: now(),
  };
};
