import { useEffect, useState } from "react";
import type { Settings } from "../../lib/types";
import type { RepositoryIndexSnapshot } from "../../../backend/workspace/discovery";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
export const DiscoverySettings = ({
  value,
  onChange,
}: {
  value: Settings["repository_discovery"];
  onChange: (value: Settings["repository_discovery"]) => void;
}) => {
  const [index, setIndex] = useState<RepositoryIndexSnapshot>();
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void rpc<RepositoryIndexSnapshot>("repositories.index")
      .then(setIndex)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const scan = async () => {
    setBusy(true);
    setError("");
    try {
      const { settings } = await rpc<import("../../lib/types").Snapshot>("snapshot");
      await rpc("settings.save", { ...settings, repository_discovery: value });
      setIndex(await rpc("repositories.scan"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="discovery-settings">
      <h2>Local repository discovery</h2>
      <p className="subtle">
        Find checkouts in the configured execution environment before cloning. Windows locations
        must be explicitly added as /mnt/c/Users/… paths. WSL checkouts are preferred.
      </p>
      <div className="search-roots">
        {value.roots.map((root, i) => (
          <div key={i}>
            <input
              aria-label={`Search root ${i + 1}`}
              value={root}
              onChange={(e) =>
                onChange({
                  ...value,
                  roots: value.roots.map((r, n) => (n === i ? e.target.value : r)),
                })
              }
            />
            <Button
              size="sm"
              aria-label={`Remove ${root}`}
              onClick={() =>
                onChange({
                  ...value,
                  roots: value.roots.filter((_, n) => n !== i),
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <div className="actions">
        <input
          aria-label="New repository location"
          placeholder="~/projects or /mnt/c/Users/name/repos"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <Button
          disabled={!location.trim()}
          onClick={() => {
            onChange({ ...value, roots: [...value.roots, location.trim()] });
            setLocation("");
          }}
        >
          + Add location
        </Button>
      </div>
      <label>
        Maximum depth
        <input
          type="number"
          min={1}
          max={8}
          value={value.max_depth}
          onChange={(e) => onChange({ ...value, max_depth: Number(e.target.value) })}
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value.scan_home}
          onChange={(e) => onChange({ ...value, scan_home: e.target.checked })}
        />
        Scan home directory with the same depth limit
      </label>
      <Button disabled={busy} onClick={() => void scan()}>
        {busy ? "Scanning…" : "Scan now"}
      </Button>
      {error && <p className="error-box">{error}</p>}
      <p>Repositories indexed: {index?.repositories.length || 0}</p>
      <p className="subtle">
        Last scan: {index?.last_scan ? new Date(index.last_scan).toLocaleString() : "Not scanned"} ·
        Scan duration:{" "}
        {index?.duration_ms === null || index?.duration_ms === undefined
          ? "—"
          : `${(index.duration_ms / 1000).toFixed(1)}s`}
      </p>
      {index?.warnings.map((w) => (
        <p className="warning-box" key={w}>
          {w}
        </p>
      ))}
      {index?.repositories.map((repo) => (
        <p className="indexed-repo" key={repo.path}>
          <code>{repo.path}</code>
          <small>
            {repo.environment === "wsl"
              ? "WSL checkout — Recommended"
              : "Windows checkout — Available"}{" "}
            · {repo.identities.join(", ")}
          </small>
        </p>
      ))}
    </section>
  );
};
