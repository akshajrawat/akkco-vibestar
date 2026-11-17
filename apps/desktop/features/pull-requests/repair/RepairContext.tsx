import { AgentResponse } from "../../chat/AgentResponse";
import type { RepairDetail } from "./types";

export const RepairActions = ({ session }: { session: RepairDetail["session"] }) => (
  <>
    <h3>Review action checklist</h3>
    {session.actions.map((action) => (
      <article key={action.id}>
        <strong>{action.classification.replaceAll("_", " ")}</strong>
        <AgentResponse text={action.originalText} />
        <small>
          @{action.reviewer} · source {action.sourceId}
        </small>
      </article>
    ))}
  </>
);

export const RepairIdentity = ({ session }: { session: RepairDetail["session"] }) => {
  const workspace = session.workspace;
  return (
    <>
      <h3>Git identity</h3>
      <dl className="repository-facts">
        <dt>Fork / branch</dt>
        <dd>
          {session.identity.head.name}:<code>{session.identity.head.branch}</code>
        </dd>
        <dt>Original PR head</dt>
        <dd>
          <code>{workspace.original_head}</code>
        </dd>
        <dt>Upstream base</dt>
        <dd>
          {session.identity.base.branch}
          <code>{workspace.fetched_base}</code>
        </dd>
        <dt>Worktree</dt>
        <dd>
          <code>{workspace.worktree_path}</code>
        </dd>
        <dt>Local branch</dt>
        <dd>
          <code>{workspace.branch_name}</code>
        </dd>
      </dl>
    </>
  );
};
