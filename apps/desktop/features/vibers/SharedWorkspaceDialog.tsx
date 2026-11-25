import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { Button } from "../../components/ui/button";

export const SharedWorkspaceDialog = ({
  viberName,
  allow,
  keepIsolated,
  cancel,
}: {
  viberName: string;
  allow: () => void;
  keepIsolated: () => void;
  cancel: () => void;
}) => (
  <WorkspaceOverlay
    label="Shared workspace permission"
    className="max-w-[460px] p-6"
    onClose={cancel}
  >
    <h2>Allow shared workspace access?</h2>
    <p className="mt-2 text-sm text-ink-secondary">
      Allowing access lets {viberName} use files that other Vibers save in the Shared Computer
      workspace for this turn.
    </p>
    <div className="mt-5 flex flex-wrap justify-end gap-2">
      <Button variant="ghost" onClick={cancel}>
        Cancel
      </Button>
      <Button variant="secondary" onClick={keepIsolated}>
        Keep isolated
      </Button>
      <Button onClick={allow}>Allow for this turn</Button>
    </div>
  </WorkspaceOverlay>
);
