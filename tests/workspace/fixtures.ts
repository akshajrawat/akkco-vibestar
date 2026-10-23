import type { Detail } from "../../src/lib/types";

export const workspaceDetail = (id: string): Detail => ({
  task: {
    id,
    repo_id: "repo",
    issue_number: 1,
    issue_url: "https://github.com/fixture/repo/issues/1",
    claimed_scope: "Chat workspace",
    notes: "",
    issue: { title: "Conversation remains primary" },
    branch_name: "task/fixture",
    base_branch: "main",
    base_commit_sha: "base",
    worktree_path: "/owned/worktree",
    created_at: "2026-10-22T00:00:00Z",
    updated_at: "2026-10-22T00:00:00Z",
    status: "cancelled",
    stage: 1,
    error: null,
  },
  messages: [],
  events: [],
  runs: [],
  artifacts: [],
  tests: [],
});
