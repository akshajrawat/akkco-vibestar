import { execute, capture } from "../execution/process";
import { AdeError } from "../domain";
import type { GitHubRepository, GitHubStatus } from "./contracts";
export class GitHubClient {
  constructor(private readonly cwd: string) {}
  gh = async (args: string[], signal?: AbortSignal) => {
    const result = await execute({
      program: "gh",
      args,
      cwd: this.cwd,
      signal,
      timeoutMs: 60000,
    });
    if (result.code !== 0)
      throw new AdeError(
        "github",
        `GitHub CLI: ${result.stderr.slice(-3000) || result.stdout.slice(-3000)}`,
      );
    return result.stdout;
  };
  api = async <T>(endpoint: string, signal?: AbortSignal): Promise<T> =>
    JSON.parse(await this.gh(["api", "--method", "GET", endpoint], signal));
  pages = async <T>(endpoint: string, signal?: AbortSignal) => {
    const rows: T[] = [];
    for (let page = 1; page <= 1000; page++) {
      const part = await this.api<T[]>(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        signal,
      );
      if (!Array.isArray(part))
        throw new AdeError(
          "github",
          "Unexpected repository pagination response",
        );
      rows.push(...part);
      if (part.length < 100) return rows;
    }
    throw new AdeError(
      "github",
      "GitHub pagination limit reached; catalog was not advanced",
    );
  };
  detect = async (signal?: AbortSignal): Promise<GitHubStatus> => {
    const status: GitHubStatus = {
      installed: false,
      connected: false,
      username: null,
      version: "",
      error: null,
    };
    try {
      const version = await capture("gh", ["--version"], this.cwd, signal);
      status.installed = version.code === 0;
      status.version = version.stdout.split("\n")[0];
      if (!status.installed) return status;
      // auth status output is never returned or stored: it can contain token metadata.
      const auth = await capture(
        "gh",
        ["auth", "status", "--hostname", "github.com"],
        this.cwd,
        signal,
      );
      if (auth.code !== 0) return status;
      status.username = (
        await this.api<{ login: string }>("user", signal)
      ).login;
      status.connected = true;
    } catch (e) {
      status.error = String(e);
    }
    return status;
  };
  repository = async (
    name: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepository> => {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(name) ||
      name.split("/").some((p) => p === "." || p === "..")
    )
      throw new AdeError("invalid_input", "Use owner/repository");
    try {
      return await this.api<GitHubRepository>(`repos/${name}`, signal);
    } catch {
      const response = await fetch(`https://api.github.com/repos/${name}`, {
        headers: {
          "User-Agent": "akkco-vibestar",
          Accept: "application/vnd.github+json",
        },
        signal: signal || AbortSignal.timeout(30000),
      });
      if (!response.ok)
        throw new AdeError(
          "github",
          `Cannot resolve ${name} (${response.status}); connect GitHub for private repositories`,
        );
      return response.json() as Promise<GitHubRepository>;
    }
  };
  authored = async (username: string, signal?: AbortSignal) => {
    // Search upstream PRs across the account, including PRs whose heads are forks.
    // GitHub search caps any single query at 1,000; partition by creation time.
    const search = async (
      from: number,
      until: number,
    ): Promise<
      { html_url: string; title: string; number: number; updated_at: string }[]
    > => {
      const q = `is:pr is:open author:${username} created:${new Date(from).toISOString()}..${new Date(until).toISOString()}`;
      const endpoint = `search/issues?q=${encodeURIComponent(q)}&per_page=100`;
      const first = await this.api<{
        total_count: number;
        incomplete_results: boolean;
        items: {
          html_url: string;
          title: string;
          number: number;
          updated_at: string;
        }[];
      }>(`${endpoint}&page=1`, signal);
      if (first.incomplete_results)
        throw new AdeError(
          "github",
          "GitHub returned incomplete PR results; retry sync",
        );
      if (first.total_count > 1000) {
        const mid = Math.floor((from + until) / 2000) * 1000;
        if (mid <= from)
          throw new AdeError(
            "github",
            "More than 1,000 PRs in one second; sync cannot safely enumerate them",
          );
        return [
          ...(await search(from, mid)),
          ...(await search(mid + 1000, until)),
        ];
      }
      const rows = first.items;
      for (let page = 2; page <= Math.ceil(first.total_count / 100); page++) {
        const part = await this.api<typeof first>(
          `${endpoint}&page=${page}`,
          signal,
        );
        if (part.incomplete_results)
          throw new AdeError(
            "github",
            "GitHub returned incomplete PR results; retry sync",
          );
        rows.push(...part.items);
      }
      return rows;
    };
    return [
      ...new Map(
        (await search(Date.UTC(2008, 0, 1), Date.now())).map((p) => [
          p.html_url,
          p,
        ]),
      ).values(),
    ];
  };
}
