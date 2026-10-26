import { useState } from "react";
import { X } from "lucide-react";
import { parseLabelInput } from "./labels";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";

export const LabelExclusions = ({
  repository,
  labels,
  change,
}: {
  repository: string;
  labels: string[];
  change: (labels: string[]) => void;
}) => {
  const [input, setInput] = useState("");
  const [catalog, setCatalog] = useState<{
    repository: string;
    labels: string[];
  }>({ repository: "", labels: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const add = (value: string) => {
    try {
      const parsed = parseLabelInput(value, repository);
      const next = [...labels];
      for (const label of parsed)
        if (!next.some((item) => item.toLowerCase() === label.toLowerCase())) next.push(label);
      if (next.length > 30) throw new Error("Choose at most 30 excluded labels.");
      change(next);
      setInput("");
      setError("");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setCatalog({
        repository,
        labels: await rpc<string[]>("issueWatch.labels", { repository }),
      });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section
      className="label-exclusions"
      aria-label="Label exclusions"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        add(
          event.dataTransfer
            .getData("text/uri-list")
            .split("\n")
            .filter((line) => !line.startsWith("#"))
            .join("\n") || event.dataTransfer.getData("text/plain"),
        );
      }}
    >
      <label>
        Excluded labels
        <input
          aria-label="Excluded labels"
          list="watch-label-catalog"
          value={input}
          placeholder="Label name or GitHub label link"
          onChange={(event) => setInput(event.target.value)}
          onPaste={(event) => {
            const value = event.clipboardData.getData("text/plain");
            if (value) {
              event.preventDefault();
              add(value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              if (input.trim()) add(input);
            }
          }}
        />
      </label>
      <datalist id="watch-label-catalog">
        {(catalog.repository === repository ? catalog.labels : []).map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      <div className="label-chips">
        {labels.map((label) => (
          <span className="context-chip" key={label}>
            {label}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove label ${label}`}
              onClick={() => change(labels.filter((item) => item !== label))}
            >
              <X size={12} />
            </Button>
          </span>
        ))}
      </div>
      <div className="actions">
        <Button size="sm" variant="ghost" onClick={() => add(input)} disabled={!input.trim()}>
          Add label
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={loading || !repository.trim()}
        >
          {loading ? "Loading labels…" : "Find GitHub labels"}
        </Button>
      </div>
      <small>
        Paste or drop a GitHub label link, or type a name and press Enter or Add label. Exclusions
        match exact labels, case insensitive.
      </small>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};
