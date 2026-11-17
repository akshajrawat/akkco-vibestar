import { WorkspaceOverlay } from "./WorkspaceOverlay";
import { Button } from "./button";

export const DiscardChangesDialog = ({
  keep,
  discard,
}: {
  keep: () => void;
  discard: () => void;
}) => (
  <WorkspaceOverlay
    label="Discard unsaved changes?"
    className="workspace-confirmation"
    onClose={keep}
  >
    <h2>Discard unsaved changes?</h2>
    <p>Your changes have not been saved. Keep editing to save them, or discard them and close.</p>
    <div className="actions">
      <Button onClick={keep}>Keep editing</Button>
      <Button variant="destructive" onClick={discard}>
        Discard changes
      </Button>
    </div>
  </WorkspaceOverlay>
);
