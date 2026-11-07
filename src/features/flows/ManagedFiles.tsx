import { useEffect, useState } from "react";

import type { managedFiles } from "../../../backend/flows/files";
import { rpc, errorMessage } from "../../lib/api";

export const ManagedFiles = ({ taskId, revision }: { taskId: string; revision: number }) => {
  const [value, setValue] = useState<Awaited<ReturnType<typeof managedFiles>>>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    void rpc<NonNullable<typeof value>>("flow.files", {
      task_id: taskId,
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
  }, [taskId, selected, revision]);

  return (
    <div className="flow-files">
      <aside>
        <p className="subtle">Managed files · no Git baseline</p>
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
            {value?.files.length
              ? "Select a file to inspect."
              : "No files yet. Start a Viber or open the terminal."}
          </p>
        )}
      </div>
    </div>
  );
};
