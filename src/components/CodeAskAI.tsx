import { useEffect, useState } from "react";
import type { Task, Settings } from "../lib/types";
import type { CodeQuestion } from "../../backend/review/service";
import { rpc, errorMessage } from "../lib/api";
import { useProviders } from "../lib/useWorkspace";
import { configurationError } from "../../backend/execution/providers/contracts";
import { defaultSettings } from "../../backend/domain";
import { updateTaskView } from "../lib/taskView";
import { AgentConfiguration } from "./StageSettings";
import { AgentResponse } from "./AgentResponse";
import { Button } from "./ui/button";

export const CodeAskAI = ({
  task,
  path,
  oldPath,
  selection,
  revision,
}: {
  task: Task;
  path: string;
  oldPath?: string | null;
  selection: { start: number; end: number; side: "base" | "working" };
  revision: number;
}) => {
  const [question, setQuestion] = useState("Why was this changed?");
  const [questions, setQuestions] = useState<CodeQuestion[]>([]);
  const [parent, setParent] = useState<CodeQuestion>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [config, setConfig] = useState<Settings["utility_ai"]>(
    defaultSettings.utility_ai,
  );
  const { providers } = useProviders();
  useEffect(() => {
    void rpc<{ settings: Settings }>("snapshot")
      .then((s) => setConfig(s.settings.review_ai || s.settings.utility_ai))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    let alive = true;
    void rpc<CodeQuestion[]>("review.questions", { id: task.id })
      .then((rows) => {
        if (alive) setQuestions(rows);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [task.id, revision, refresh]);
  const detected = providers.find((p) => p.provider === config.provider);
  const invalid = detected ? configurationError(detected, config) : null;
  const action = async (method: string, params: unknown) => {
    setBusy(true);
    setError("");
    try {
      await rpc(method, params);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
      setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="code-ask-ai" aria-label="Selected code Ask AI">
      <div className="section-heading">
        <strong>Ask AI · read-only</strong>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          {config.provider} ·{" "}
          {detected?.models.find((m) => m.id === config.model)?.label ||
            config.model ||
            "CLI default"}{" "}
          · {config.effort} ▾
        </Button>
      </div>
      <small className="subtle">
        {path} · {parent?.side || selection.side} · lines{" "}
        {parent?.line_start || selection.start}–
        {parent?.line_end || selection.end}
      </small>
      {settingsOpen && (
        <div className="review-model-settings">
          <label>
            Provider
            <select
              value={config.provider}
              onChange={(e) =>
                setConfig({
                  ...config,
                  provider: e.target.value as "codex" | "antigravity",
                  model: "",
                })
              }
            >
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
            </select>
          </label>
          <AgentConfiguration
            id="review-question"
            label="Review / explain AI"
            provider={config.provider}
            config={config}
            providers={providers}
            onChange={(value) =>
              setConfig({ ...value, provider: config.provider })
            }
          />
        </div>
      )}
      <div className="ask-presets">
        {["Explain", "Review", "Find bug", "Suggest tests"].map((label) => (
          <Button
            size="sm"
            variant="ghost"
            key={label}
            onClick={() => {
              setParent(undefined);
              setQuestion(
                {
                  Explain: "Why was this changed?",
                  Review: "Review this code for correctness and clarity.",
                  "Find bug": "Can you find a bug in this selected code?",
                  "Suggest tests": "Which tests should cover this change?",
                }[label]!,
              );
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action("review.ask", {
            id: task.id,
            path,
            old_path: oldPath,
            side: parent?.side || selection.side,
            line_start: parent?.line_start || selection.start,
            line_end: parent?.line_end || selection.end,
            question,
            parent_id: parent?.id,
            configuration: config,
          });
        }}
      >
        <textarea
          aria-label="Ask about selected code"
          rows={2}
          value={question}
          maxLength={4000}
          onChange={(e) => setQuestion(e.target.value)}
        />
        {parent && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setParent(undefined)}
          >
            Clear follow-up context
          </Button>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={busy || !question.trim() || !!invalid}
        >
          {busy ? "Asking…" : "Ask AI"}
        </Button>
      </form>
      {invalid && <small className="warning">{invalid}</small>}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <div className="code-answers">
        {questions
          .filter((q) => q.path === path)
          .map((q) => (
            <article key={q.id}>
              <small className="subtle">
                {q.side} · lines {q.line_start}–{q.line_end} · {q.status}
              </small>
              <strong>{q.question}</strong>
              {q.answer ? (
                <AgentResponse text={q.answer} />
              ) : q.error ? (
                <div className="code-question-error">
                  <strong className="warning">
                    {q.status === "cancelled"
                      ? "Question cancelled"
                      : "Couldn't answer this question"}
                  </strong>
                  <details>
                    <summary>Technical details</summary>
                    <pre>{errorMessage(q.error)}</pre>
                  </details>
                  <Button
                    size="sm"
                    onClick={() => {
                      setParent(q);
                      setQuestion(q.question);
                    }}
                  >
                    Retry question
                  </Button>
                </div>
              ) : (
                <p className="subtle">
                  Provider is answering. Stop is available in the current run
                  strip.
                </p>
              )}
              <div className="message-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    updateTaskView(task.id, {
                      tab: "Chat",
                      contextPane: "none",
                    })
                  }
                >
                  View in Chat
                </Button>
                {q.answer && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void action("review.add", {
                          id: task.id,
                          path: q.path,
                          old_path: q.old_path,
                          side: q.side,
                          line_start: q.line_start,
                          line_end: q.line_end,
                          content: `${q.question}\n\n${q.answer}`.slice(
                            0,
                            8000,
                          ),
                        })
                      }
                    >
                      Add review note
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setParent(q);
                        setQuestion("");
                      }}
                    >
                      Ask follow-up
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Start an implementation continuation using this review feedback? This run may edit the task worktree.",
                          )
                        )
                          void action("task.followup", {
                            id: task.id,
                            content: `Apply review feedback for ${q.path}:${q.line_start}–${q.line_end} (${q.side}).\nQuestion: ${q.question}\nFeedback: ${q.answer}\nCode at review time (verify against current file):\n${q.selected_code}`,
                          });
                      }}
                    >
                      Request change
                    </Button>
                  </>
                )}
              </div>
            </article>
          ))}
      </div>
    </section>
  );
};
