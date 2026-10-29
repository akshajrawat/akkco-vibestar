import { execute, capture } from "../execution/runtime/process";
import { AdeError } from "../domain";
import type { GitHubRepository, GitHubStatus } from "./contracts";
import { authoredPullRequests, knownPullRequests } from "./pull-requests";

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
    JSON.parse(
      await this.gh(["api", "--hostname", "github.com", "--method", "GET", endpoint], signal),
    );

  pages = async <T>(
    endpoint: string,
    signal?: AbortSignal,
    maxPages = 1000,
    collection?: string,
    onPage?: (page: number, loaded: number) => void,
  ) => {
    const rows: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      onPage?.(page, rows.length);

      const response = await this.api<unknown>(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        signal,
      );

      const part =
        collection && response && typeof response === "object"
          ? (response as Record<string, unknown>)[collection]
          : response;

      if (!Array.isArray(part))
        throw new AdeError("github", "Unexpected repository pagination response");
      rows.push(...part);
      onPage?.(page, rows.length);
      if (part.length < 100) return rows;
    }

    throw new AdeError("github", "GitHub pagination limit reached; catalog was not advanced");
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
      status.username = (await this.api<{ login: string }>("user", signal)).login;
      status.connected = true;
    } catch (e) {
      status.error = String(e);
    }

    return status;
  };

  repository = async (name: string, signal?: AbortSignal): Promise<GitHubRepository> => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name) || name.split("/").some((p) => p === "." || p === ".."))
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

  graphql = async (
    query: string,
    variables: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    JSON.parse(
      await this.gh(
        [
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          `query=${query}`,
          ...Object.entries(variables).flatMap(([key, value]) => ["-f", `${key}=${value}`]),
        ],
        signal,
      ),
    );

  authored = (username: string, signal?: AbortSignal) =>
    authoredPullRequests(username, (query, variables) => this.graphql(query, variables, signal));

  pullRequests = (urls: string[], signal?: AbortSignal) =>
    knownPullRequests(urls, (query, variables) => this.graphql(query, variables, signal));
}
