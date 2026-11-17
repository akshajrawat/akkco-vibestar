import { useRef, useState } from "react";

import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { Button } from "../../components/ui/button";
import { rpc, errorMessage } from "../../lib/api";
import { RunError } from "../chat/RunError";

export const ViberRecoveryDialog = ({
  sessionId,
  profileId,
  activity,
  cancel,
  confirm,
}: {
  sessionId: string;
  profileId: string;
  activity: React.ReactNode;
  cancel: () => void;
  confirm: () => void;
}) => {
  const [inspection, setInspection] = useState<{
    files: string[];
    text: string | null;
    path: string | null;
  }>();

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const requested = useRef(0);

  const inspect = async (path?: string) => {
    const request = ++requested.current;
    setBusy(true);
    setError("");
    try {
      const next = await rpc<NonNullable<typeof inspection>>("viber.session.inspect", {
        session_id: sessionId,
        profile_id: profileId,
        ...(path ? { path } : {}),
      });

      if (request === requested.current) {
        setInspection(next);
      }
    } catch (reason) {
      if (request === requested.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (request === requested.current) {
        setBusy(false);
      }
    }
  };

  return (
    <WorkspaceOverlay
      label="Review previous work"
      className="viber-recovery-dialog"
      onClose={cancel}
    >
      <h2>Review previous work</h2>
      <p>
        The previous response stopped before its outcome was confirmed. Commands or file changes may
        already have happened.
      </p>
      <p>
        Inspect the activity and files before continuing. Your next message starts only when you
        confirm.
      </p>
      <Button variant="secondary" disabled={busy} onClick={() => void inspect()}>
        {busy ? "Inspecting…" : "Inspect activity and files"}
      </Button>
      {(inspection || error) && (
        <div className="viber-recovery-inspection">
          {activity}
          {error && <RunError error={error} conversation />}
          {inspection && (
            <>
              <h3>Workspace files</h3>
              <p className="subtle">
                Repository chats list changed files. Isolated chats list saved files without a Git
                baseline.
              </p>
              {!inspection.files.length && <p>No workspace files to inspect.</p>}
              <div className="viber-recovery-files">
                {inspection.files.map((path) => (
                  <Button
                    key={path}
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void inspect(path)}
                  >
                    {path}
                  </Button>
                ))}
              </div>
              {inspection.path && <h4>{inspection.path}</h4>}
              {inspection.text !== null && <pre>{inspection.text}</pre>}
            </>
          )}
        </div>
      )}
      <div className="actions">
        <Button variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button onClick={confirm}>I understand, continue</Button>
      </div>
    </WorkspaceOverlay>
  );
};
