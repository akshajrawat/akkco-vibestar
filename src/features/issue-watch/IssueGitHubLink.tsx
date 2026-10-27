import { ArrowUpRight } from "lucide-react";

import type { IssueSnapshot } from "../../../backend/issue-watch/contracts";
import { parseIssue } from "../../../backend/domain";
import { Button } from "../../components/ui/button";
import { errorMessage } from "../../lib/api";

export const verifiedIssueUrl = (issue: Pick<IssueSnapshot, "repository" | "number" | "url">) => {
  try {
    const reference = parseIssue(issue.url);
    const expected = `https://github.com/${issue.repository}/issues/${issue.number}`;
    return reference.number === issue.number &&
      `${reference.owner}/${reference.repo}`.toLowerCase() === issue.repository.toLowerCase() &&
      issue.url === expected
      ? expected
      : null;
  } catch {
    return null;
  }
};

export const IssueGitHubLink = ({
  issue,
  onError,
}: {
  issue: Pick<IssueSnapshot, "repository" | "number" | "url">;
  onError: (error: string) => void;
}) => {
  const url = verifiedIssueUrl(issue);
  return url ? (
    <Button asChild size="sm" variant="ghost">
      <a
        href={url}
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void window.vibestar.openExternal(url).catch((error) => onError(errorMessage(error)));
        }}
      >
        <ArrowUpRight size={13} /> Open on GitHub
      </a>
    </Button>
  ) : (
    <small className="warning">Issue link needs verification</small>
  );
};
