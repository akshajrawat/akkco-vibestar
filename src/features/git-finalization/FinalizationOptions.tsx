import type { GitPreset } from "../../../backend/finalization/contracts";
import { useState } from "react";
import type { Repository } from "../../lib/types";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/Select";
import { errorMessage, rpc } from "../../lib/api";
import { workflows } from "./presets";
import type { FinalizationController, GitFinalizationProps } from "./useGitFinalization";

export const FinalizationOptions = ({
  controller,
  snapshot,
  repository,
  task,
  open,
  onOpenChange,
}: {
  controller: FinalizationController;
  snapshot: NonNullable<FinalizationController["snapshot"]>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Pick<GitFinalizationProps, "repository" | "task">) => {
  const {
    locked,
    preset,
    setPreset,
    committed,
    record,
    setBusy,
    setError,
    setNotice,
    setConnectingFork,
  } = controller;

  const [destination, setDestination] = useState(repository?.origin_url || "");

  return (
    <details
      className="git-options"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>Task options</summary>
      <label>
        Workflow preset
        <Select
          label="Git workflow preset"
          value={
            workflows.some((item) => item.name === preset.name) ? preset.name : "Custom safe preset"
          }
          disabled={locked || committed}
          onChange={(name) => {
            const value = workflows.find((item) => item.name === name);
            if (value) setPreset({ ...preset, ...value });
          }}
          options={[
            ...workflows.map((item) => ({ value: item.name, label: item.name })),
            { value: "Custom safe preset", label: "Custom safe preset" },
          ]}
        />
      </label>
      <div className="form-grid">
        <label>
          Commit hooks
          <Select
            label="Git commit mode"
            value={preset.commit_hooks}
            disabled={locked || committed}
            onChange={(commit_hooks) =>
              setPreset({
                ...preset,
                name: "Custom safe preset",
                commit_hooks: commit_hooks as GitPreset["commit_hooks"],
              })
            }
            options={[
              { value: "normal", label: "Normal commit" },
              { value: "skip", label: "No-verify commit" },
            ]}
          />
        </label>
        <label>
          Push hooks
          <Select
            label="Git push mode"
            value={preset.push}
            disabled={locked || record?.status === "published"}
            onChange={(push) =>
              setPreset({
                ...preset,
                name: "Custom safe preset",
                push: push as GitPreset["push"],
              })
            }
            options={[
              { value: "normal", label: "Normal push" },
              { value: "skip", label: "No-verify push" },
              { value: "none", label: "Keep local" },
            ]}
          />
        </label>
      </div>
      <div className="form-grid">
        <label>
          Target remote
          <Select
            label="Git target remote"
            value={preset.remote}
            disabled={locked || record?.status === "published"}
            onChange={(remote) => setPreset({ ...preset, remote })}
            options={[
              ...(repository?.origin_url
                ? [
                    {
                      value: repository.origin_remote || "origin",
                      label: repository.origin_remote || "origin",
                      description: repository.origin_url,
                    },
                  ]
                : []),
              {
                value: repository?.upstream_remote || "upstream",
                label: repository?.upstream_remote || "upstream",
                description: repository?.upstream_url,
              },
            ]}
          />
        </label>
        <label>
          Target branch
          <input
            aria-label="Git target branch"
            value={preset.branch}
            disabled={locked || record?.status === "published"}
            onChange={(event) => setPreset({ ...preset, branch: event.target.value })}
          />
        </label>
      </div>
      <small>
        Push permission and the exact remote head are checked before confirmation and again before
        publishing. Presets never authorize a push.
      </small>
      <div className="actions">
        <Button
          size="sm"
          disabled={locked}
          onClick={async () => {
            setBusy("Saving preset…");
            setError("");
            try {
              await rpc("git.preset", { id: task.id, preset });
              setNotice("Task options saved.");
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setBusy("");
            }
          }}
        >
          Save task preset
        </Button>
        {repository?.source === "imported" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => setConnectingFork(true)}
          >
            Choose repository remotes
          </Button>
        )}
      </div>
      {repository && repository.source !== "imported" && (
        <details>
          <summary>Connect a push repository</summary>
          <label>
            Push repository
            <input
              aria-label="Push repository"
              value={destination}
              disabled={locked}
              placeholder="https://github.com/you/project"
              onChange={(event) => setDestination(event.target.value)}
            />
          </label>
          <p className="muted">
            Connect a verified writable repository or contribution fork. This changes the managed
            clone’s destination and starts no push.
          </p>
          <Button
            size="sm"
            disabled={locked || !destination.trim()}
            onClick={async () => {
              setBusy("Verifying and connecting destination…");
              setError("");
              try {
                const saved = await rpc<Repository>("repository.configureDestination", {
                  id: repository.id,
                  repository: destination,
                  confirmed: true,
                });

                setDestination(saved.origin_url || "");
                setPreset({ ...preset, remote: saved.origin_remote || "origin" });
                setNotice("Destination connected. Check and confirm your next push separately.");
              } catch (error) {
                setError(errorMessage(error));
              } finally {
                setBusy("");
              }
            }}
          >
            Verify and connect
          </Button>
        </details>
      )}
      <details>
        <summary>Hook policy and local commit details</summary>
        <p className="muted">
          No-verify skips optional hooks. Mandatory verification, ownership, review, ancestry and
          remote head checks always apply. Normal hooks run in the read-only sandbox.
        </p>
        {snapshot.hook_configuration === "/dev/null" && (
          <p className="warning">Repository configuration disables optional hooks.</p>
        )}
        {record?.head && <code>{record.head}</code>}
      </details>
    </details>
  );
};
