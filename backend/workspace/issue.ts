import { AdeError, type IssueRef } from "../domain";
import { capture } from "../execution/process";
export const fetchIssue = async (reference: IssueRef, cwd: string) => {
  try {
    const o = await capture(
      "gh",
      [
        "issue",
        "view",
        reference.url,
        "--json",
        "title,body,comments,labels,state,url,number",
      ],
      cwd,
    );
    if (o.code === 0) return JSON.parse(o.stdout) as Record<string, unknown>;
  } catch {
    /* Public GitHub REST fallback needs no stored credentials. */
  }
  const base = `https://api.github.com/repos/${reference.owner}/${reference.repo}/issues/${reference.number}`;
  const get = async (url: string) => {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "akkco-vibestar/0.1",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new AdeError(
        "github",
        `GitHub issue retrieval returned ${response.status}. Run gh auth login in the configured WSL distro for private issues or higher rate limits.`,
      );
    return response.json();
  };
  const issue = (await get(base)) as Record<string, unknown>;
  if (issue.pull_request)
    throw new AdeError(
      "invalid_input",
      "URL identifies a pull request, not an issue",
    );
  const comments: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const part = (await get(
      `${base}/comments?per_page=100&page=${page}`,
    )) as unknown[];
    comments.push(...part);
    if (part.length < 100) break;
    if (page === 100)
      throw new AdeError(
        "github",
        "Issue exceeds 10,000 comments; use authenticated gh CLI",
      );
  }
  return {
    title: issue.title,
    body: issue.body,
    comments,
    labels: issue.labels,
    state: issue.state,
    url: reference.url,
    number: reference.number,
  };
};
