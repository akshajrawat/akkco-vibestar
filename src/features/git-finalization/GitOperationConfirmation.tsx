import type { FinalizationView, GitPreset } from "../../../backend/finalization/contracts";
import { Button } from "../../components/ui/button";

export type Confirmation = {
  kind: "commit" | "push" | "both";
  operation: FinalizationView;
  destination: FinalizationView["destination"];
  signature: string;
};

export const GitOperationConfirmation = ({
  confirmation,
  message,
  preset,
  confirmed,
  setConfirmed,
  locked,
  onConfirm,
  onCancel,
}: {
  confirmation: Confirmation;
  message: string;
  preset: GitPreset;
  confirmed: boolean;
  setConfirmed: (confirmed: boolean) => void;
  locked: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => (
  <section className="git-confirmation" aria-label="Confirm Git operation">
    <h3>
      {confirmation.kind === "both"
        ? "Commit & Push"
        : confirmation.kind === "push"
          ? "Push commit"
          : "Commit changes"}
    </h3>
    {confirmation.destination && (
      <p>
        <strong>{confirmation.destination.repository}</strong> ·{" "}
        <code>{confirmation.destination.branch}</code>
      </p>
    )}
    <ul>
      {confirmation.operation.paths.map((path) => (
        <li key={path}>
          <code>{path}</code>
        </li>
      ))}
    </ul>
    <pre className="git-exact-message">
      {confirmation.operation.head ? confirmation.operation.message : message}
    </pre>
    <small>
      Commit: {preset.commit_hooks === "skip" ? "no-verify" : "normal"} · Push:{" "}
      {confirmation.kind === "commit" ? "none" : preset.push === "skip" ? "no-verify" : "normal"}
    </small>
    <label className="inline-check">
      <input
        type="checkbox"
        checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)}
      />
      I confirm these files, exact message and
      {confirmation.destination ? " destination." : " local commit."}
    </label>
    <div className="actions">
      <Button variant="default" disabled={locked || !confirmed} onClick={onConfirm}>
        {confirmation.kind === "both"
          ? "Confirm Commit & Push"
          : confirmation.kind === "push"
            ? "Confirm push"
            : "Confirm commit"}
      </Button>
      <Button variant="ghost" disabled={locked} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  </section>
);
