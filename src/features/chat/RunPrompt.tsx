import type { Run } from "../../lib/types";
export const RunPrompt = ({ run }: { run: Run }) => (
  <details className="run-prompt">
    <summary>
      Prompt sent · {run.provider} · {run.purpose || `Stage ${run.stage}`}
    </summary>
    <small>
      Exact saved prompt, with secrets redacted. Sent {new Date(run.started_at).toLocaleString()}.
    </small>
    <pre>{run.prompt || "No prompt was saved for this historical run."}</pre>
  </details>
);
