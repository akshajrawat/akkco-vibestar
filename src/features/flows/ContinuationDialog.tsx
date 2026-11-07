import type { ContinuationPlan } from "../../../backend/flows/continuation";
import { Button } from "../../components/ui/button";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";

export const ContinuationDialog = ({
  plan,
  busy,
  close,
  apply,
}: {
  plan: ContinuationPlan;
  busy: boolean;
  close: () => void;
  apply: () => void;
}) => {
  const focus = useDialogFocus(true);
  return (
    <div className="modal-backdrop">
      <section
        ref={focus}
        className="modal flow-continuation-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Apply saved flow revision"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) close();
          containDialogFocus(event);
        }}
      >
        <div className="modal-heading">
          <h2>Apply revision {plan.revision}</h2>
          <Button onClick={close} disabled={busy}>
            Close
          </Button>
        </div>
        <p>
          The previous run stays in history. Proved results are linked to the new run; stale and
          unfinished work will execute only after you apply this preview.
        </p>
        <ul>
          {plan.nodes.map((node) => (
            <li key={node.node_id}>
              <strong>{node.name}</strong>
              <span>
                {node.status === "reuse"
                  ? "Reuse completed result"
                  : node.status === "stale"
                    ? "Recompute stale result"
                    : "Run unfinished node"}
              </span>
              <small>{node.reason}</small>
            </li>
          ))}
        </ul>
        <p className="subtle">
          A change to settings, inputs or the workspace invalidates this preview. Approvals remain
          bound to their exact captured evidence.
        </p>
        <Button variant="default" onClick={apply} disabled={busy}>
          Apply and run remaining work
        </Button>
      </section>
    </div>
  );
};
