import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { parseIssue, remoteIdentity } from "../../../backend/domain";
import type {
  Watch,
  WatchConfiguration,
  WatchRevision,
  WatchRules,
} from "../../../backend/issue-watch/contracts";
import type { previewRules } from "../../../backend/issue-watch/rules";
import type { Snapshot } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { useProviders } from "../../lib/useWorkspace";
import { useDialogFocus } from "../../lib/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";
import { AgentConfiguration } from "../StageSettings";
import { Button } from "../ui/button";

export const WatchEditor = ({
  initial,
  snapshot,
  close,
  saved,
}: {
  initial?: { watch: Watch; revision: WatchRevision };
  snapshot: Snapshot;
  close: () => void;
  saved: (id: string) => void;
}) => {
  const original = initial?.revision.configuration;
  const [name, setName] = useState(initial?.watch.name || "");
  const [repository, setRepository] = useState(
    initial?.watch.repository.full_name || "",
  );
  const [prompt, setPrompt] = useState(original?.prompt || "");
  const [labels, setLabels] = useState(
    original?.rules.excluded_labels.join(", ") || "",
  );
  const [banned, setBanned] = useState(
    original?.rules.excluded_issues
      .map(
        (issue) =>
          `https://github.com/${issue.repository}/issues/${issue.number}`,
      )
      .join("\n") || "",
  );
  const [trackers, setTrackers] = useState<WatchRules["trackers"]>(
    original?.rules.trackers || [],
  );
  const [unassigned, setUnassigned] = useState(
    original?.rules.unassigned_only ?? true,
  );
  const [model, setModel] = useState<WatchConfiguration["model"]>(
    original?.model || {
      provider: "codex",
      model:
        snapshot.settings.utility_ai.provider === "codex"
          ? snapshot.settings.utility_ai.model
          : "",
      effort:
        snapshot.settings.utility_ai.provider === "codex"
          ? snapshot.settings.utility_ai.effort
          : "medium",
      timeout_secs: 120,
    },
  );
  const [limits, setLimits] = useState(
    original?.limits || {
      max_candidates: 200,
      max_context_candidates: 40,
      max_semantic_candidates: 20,
      max_requests: 400,
    },
  );
  const [preview, setPreview] = useState<ReturnType<
    typeof previewRules
  > | null>(null);
  const [decisions, setDecisions] = useState<
    Record<string, "" | "semantic_preference" | "confirmed_controls">
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef({ payload: "", id: "" });
  const dialog = useDialogFocus();
  const {
    providers,
    loading,
    error: providerError,
    refresh: refreshModels,
  } = useProviders();
  const invalidate = () => {
    setPreview(null);
    setDecisions({});
  };
  const compile = async () => {
    setBusy(true);
    setError("");
    try {
      const repo = remoteIdentity(
        repository.includes("://")
          ? repository
          : `https://github.com/${repository}`,
      );
      const excluded = banned
        .split(/[\n,]+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          if (/^#?[1-9]\d*$/.test(line))
            return {
              repository: `${repo.owner}/${repo.name}`,
              number: Number(line.replace("#", "")),
            };
          const ref = parseIssue(line);
          return { repository: `${ref.owner}/${ref.repo}`, number: ref.number };
        });
      const result = await rpc<ReturnType<typeof previewRules>>(
        "issueWatch.previewRules",
        {
          repository,
          prompt,
          controls: {
            excluded_labels: labels
              .split(/[,\n]+/)
              .map((label) => label.trim())
              .filter(Boolean),
            excluded_issues: excluded,
            trackers,
            unassigned_only: unassigned,
          },
        },
      );
      setPreview(result);
      setLabels(result.rules.excluded_labels.join(", "));
      setTrackers(result.rules.trackers);
      setUnassigned(result.rules.unassigned_only);
      setDecisions(
        Object.fromEntries(result.ambiguities.map((item) => [item.id, ""])),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const configuration: WatchConfiguration = {
        prompt,
        rules: preview.rules,
        preview_digest: preview.digest,
        ambiguity_decisions: preview.ambiguities.map((item) => ({
          id: item.id,
          interpretation: decisions[item.id] as
            "semantic_preference" | "confirmed_controls",
        })),
        model,
        limits,
      };
      const payload = {
        name,
        repository,
        configuration,
        ...(initial
          ? {
              watch_id: initial.watch.id,
              expected_revision: initial.watch.current_revision,
            }
          : {}),
      };
      const serialized = JSON.stringify(payload);
      if (request.current.payload !== serialized)
        request.current = { payload: serialized, id: crypto.randomUUID() };
      const result = await rpc<{ watch: Watch }>(
        initial ? "issueWatch.update" : "issueWatch.create",
        { ...payload, request_id: request.current.id },
      );
      saved(result.watch.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        className="modal watch-editor"
        role="dialog"
        aria-modal="true"
        aria-label={initial ? "Edit Issue Watch" : "New Issue Watch"}
        ref={dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            close();
          }
          containDialogFocus(event);
        }}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">MANUAL DISCOVERY</span>
            <h2>{initial ? "Edit Issue Watch" : "New Issue Watch"}</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close watch editor"
            disabled={busy}
            onClick={close}
          >
            <X size={16} />
          </Button>
        </div>
        <p className="subtle">
          Save your criteria, then scan when you choose. Saving never starts
          GitHub discovery or AI screening.
        </p>
        <fieldset disabled={busy} className="watch-editor-fields">
          <div className="watch-form-grid">
            <label>
              Watch name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Contribution opportunities"
                maxLength={120}
              />
            </label>
            <label>
              GitHub repository
              <input
                value={repository}
                onChange={(event) => {
                  setRepository(event.target.value);
                  invalidate();
                }}
                list="watch-repositories"
                placeholder="oppia/oppia or GitHub URL"
                disabled={!!initial}
              />
              <datalist id="watch-repositories">
                {snapshot.github?.repositories.map((repo) => (
                  <option key={repo.id} value={repo.full_name} />
                ))}
              </datalist>
            </label>
          </div>
          <label>
            What issues are you looking for?
            <textarea
              value={prompt}
              rows={5}
              maxLength={8000}
              onChange={(event) => {
                setPrompt(event.target.value);
                invalidate();
              }}
              placeholder="Watch for open issues that are not triage needed and are not present in https://github.com/oppia/oppia/issues/27409. Prefer actionable, well-scoped issues."
            />
          </label>
          <section className="watch-editor-section">
            <h3>Hard filters</h3>
            <p className="subtle">
              Enforced by Vibestar before and after AI. The prompt compiler
              recognizes a small grammar; unresolved requirements need
              confirmation.
            </p>
            <div className="watch-checks">
              <label>
                <input type="checkbox" checked disabled />
                GitHub issues only · Open only
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={unassigned}
                  onChange={(event) => {
                    setUnassigned(event.target.checked);
                    invalidate();
                  }}
                />
                Exclude assigned issues
              </label>
            </div>
            <div className="watch-form-grid">
              <label>
                Excluded labels
                <input
                  value={labels}
                  onChange={(event) => {
                    setLabels(event.target.value);
                    invalidate();
                  }}
                  placeholder="triage needed, needs triage"
                />
                <small>
                  Exact labels, case insensitive. Similar labels require an
                  explicit choice.
                </small>
              </label>
              <label>
                Excluded issue URLs or numbers
                <textarea
                  rows={2}
                  value={banned}
                  onChange={(event) => {
                    setBanned(event.target.value);
                    invalidate();
                  }}
                  placeholder="#123 or https://github.com/owner/repo/issues/123"
                />
              </label>
            </div>
            <p className="subtle">
              Confirmed competing open PRs and active maintainer grants are
              excluded. Possible claims, missing coverage and uncertain policies
              stay in manual review.
            </p>
          </section>
          <section className="watch-editor-section">
            <div className="watch-section-heading">
              <h3>Excluded trackers</h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={trackers.length >= 5}
                onClick={() => {
                  setTrackers([...trackers, { url: "", comments: "none" }]);
                  invalidate();
                }}
              >
                <Plus size={13} /> Add tracker
              </Button>
            </div>
            {trackers.map((tracker, index) => (
              <div className="watch-tracker-input" key={index}>
                <label>
                  Tracker {index + 1}
                  <input
                    aria-label={`Tracker ${index + 1} URL`}
                    value={tracker.url}
                    onChange={(event) => {
                      setTrackers(
                        trackers.map((item, i) =>
                          i === index
                            ? { ...item, url: event.target.value }
                            : item,
                        ),
                      );
                      invalidate();
                    }}
                    placeholder="https://github.com/oppia/oppia/issues/27409"
                  />
                </label>
                <label>
                  Reference scope
                  <select
                    value={tracker.comments}
                    onChange={(event) => {
                      setTrackers(
                        trackers.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                comments: event.target.value as "none" | "all",
                              }
                            : item,
                        ),
                      );
                      invalidate();
                    }}
                  >
                    <option value="none">Body only</option>
                    <option value="all">Body + every comment</option>
                  </select>
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove tracker ${index + 1}`}
                  onClick={() => {
                    setTrackers(trackers.filter((_, i) => i !== index));
                    invalidate();
                  }}
                >
                  <X size={14} />
                </Button>
              </div>
            ))}
            <small>
              Freshly verified for every scan. Code/HTML examples and PR links
              are skipped. Incomplete required trackers block eligibility.
            </small>
          </section>
          <section className="watch-editor-section">
            <Button
              variant="secondary"
              onClick={() => void compile()}
              disabled={!prompt.trim() || !repository.trim()}
            >
              Preview hard filters
            </Button>
            {preview && (
              <div className="watch-rule-preview">
                <h4>
                  Confirmed rule preview · compiler v{preview.compiler_version}
                </h4>
                <ul>
                  <li>
                    Open GitHub issues;{" "}
                    {preview.rules.unassigned_only
                      ? "assigned issues excluded"
                      : "assignments shown for review"}
                    .
                  </li>
                  <li>
                    {preview.rules.excluded_labels.length} exact label
                    exclusions · {preview.rules.excluded_issues.length} issue
                    bans · {preview.rules.trackers.length} dynamic trackers.
                  </li>
                </ul>
                {preview.explanation.length > 0 && (
                  <details>
                    <summary>How your words became filters</summary>
                    {preview.explanation.map((span, index) => (
                      <p key={index}>
                        <q>{span.text}</q> → {span.rule}
                      </p>
                    ))}
                  </details>
                )}
                {preview.ambiguities.map((item) => (
                  <label className="watch-ambiguity" key={item.id}>
                    <strong>Confirm meaning</strong>
                    <span>{item.text}</span>
                    <small>{item.explanation}</small>
                    <select
                      aria-label={`Interpret ${item.id}`}
                      value={decisions[item.id] || ""}
                      onChange={(event) =>
                        setDecisions({
                          ...decisions,
                          [item.id]: event.target
                            .value as (typeof decisions)[string],
                        })
                      }
                    >
                      <option value="">Choose interpretation…</option>
                      <option value="semantic_preference">
                        Treat remaining text as AI preferences
                      </option>
                      <option value="confirmed_controls">
                        The visible hard controls capture this requirement
                      </option>
                    </select>
                  </label>
                ))}
                <p className="subtle">
                  AI preferences:{" "}
                  {preview.preferences ||
                    "No additional semantic preferences detected."}
                </p>
              </div>
            )}
          </section>
          <section className="watch-editor-section">
            <h3>Subscription screening</h3>
            <label>
              Provider
              <select
                value={model.provider}
                onChange={(event) =>
                  setModel({
                    ...model,
                    provider: event.target.value as "codex" | "antigravity",
                    model: "",
                  })
                }
              >
                <option value="codex">Codex · official subscription CLI</option>
                <option value="antigravity" disabled>
                  Antigravity · unsupported for Issue Watch
                </option>
              </select>
            </label>
            <p className="subtle">
              Selected GitHub content, including private content, is sent to
              this provider during an explicit scan. Antigravity consumer-plan
              app wrapping is not officially supported.
            </p>
            <AgentConfiguration
              id="watch-model"
              label="Model and effort"
              provider={model.provider}
              config={model}
              providers={providers}
              allowDefault={false}
              maxTimeout={120}
              onChange={(config) =>
                setModel({ ...config, provider: model.provider })
              }
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void refreshModels()}
            >
              {loading
                ? "Discovering official models…"
                : "Refresh official models"}
            </Button>
            {providerError && <p className="warning">{providerError}</p>}
          </section>
          <details className="watch-editor-section">
            <summary>Collection and allowance bounds</summary>
            <div className="watch-limits-grid">
              {(
                [
                  ["max_candidates", "Candidate identities", 200],
                  ["max_context_candidates", "Detailed contexts", 40],
                  ["max_semantic_candidates", "AI candidates", 20],
                  ["max_requests", "GitHub requests", 400],
                ] as const
              ).map(([key, label, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min={key === "max_requests" ? 5 : 1}
                    max={max}
                    value={limits[key]}
                    onChange={(event) =>
                      setLimits({
                        ...limits,
                        [key]: Number(event.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <p className="subtle">
              At most one semantic CLI invocation per scan, 128 KiB input, 1 MiB
              per source, 20 MiB collected data, four concurrent GitHub
              requests. Limits produce visible partial results; no automatic
              retry. CLI internal model turns and usage depend on the official
              provider.
            </p>
          </details>
        </fieldset>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <small>No clone required · Manual scans only</small>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={
              busy ||
              !preview ||
              !name.trim() ||
              !model.model ||
              preview.ambiguities.some((item) => !decisions[item.id])
            }
          >
            {busy
              ? "Saving / validating…"
              : initial
                ? "Save new revision"
                : "Save watch"}
          </Button>
        </div>
      </section>
    </div>
  );
};
