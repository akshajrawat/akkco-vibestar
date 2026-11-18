import { useEffect, useState } from "react";

import { rpc, errorMessage } from "../../lib/api";

export const ManagedFiles = ({
  sessionId,
  profileId,
  revision,
}: {
  sessionId: string;
  profileId: string;
  revision: number;
}) => {
  const [value, setValue] = useState<{
    files: string[];
    path: string | null;
    text: string | null;
  }>();

  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    void rpc<NonNullable<typeof value>>("viber.session.files", {
      session_id: sessionId,
      profile_id: profileId,
      ...(selected ? { path: selected } : {}),
    })
      .then((next) => {
        if (alive) {
          setValue(next);
          setError("");
        }
      })
      .catch((reason) => {
        if (alive) {
          setValue(undefined);
          setError(errorMessage(reason));
        }
      });

    return () => {
      alive = false;
    };
  }, [sessionId, profileId, selected, revision]);

  return (
    <div className="viber-files">
      <aside>
        <p className="subtle">Workspace files</p>
        {value?.files.map((path) => (
          <button
            key={path}
            className={path === selected ? "selected" : ""}
            onClick={() => setSelected(path)}
          >
            {path}
          </button>
        ))}
      </aside>
      <div>
        {error ? (
          <p role="alert">{error}</p>
        ) : value?.text !== null && value?.text !== undefined ? (
          <pre>{value.text}</pre>
        ) : (
          <p className="empty-row">
            {value?.files.length ? "Select a file to inspect." : "No workspace files yet."}
          </p>
        )}
      </div>
    </div>
  );
};
