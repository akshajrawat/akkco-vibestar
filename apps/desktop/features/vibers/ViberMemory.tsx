import { useEffect, useRef, useState } from "react";
import { viberMemoryFactLimit, type ViberMemoryFact } from "../../../core/vibers/memory-contracts";
import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { errorMessage, viberMemoryRpc } from "../../lib/api";

export const ViberMemoryControl = ({
  profileId,
  name,
  repositoryId,
}: {
  profileId: string;
  name: string;
  repositoryId?: string | null;
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex shrink-0 justify-end px-3 pt-2">
      <Button size="sm" variant="ghost" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Private memory
      </Button>
      {open && (
        <ViberMemory
          profileId={profileId}
          name={name}
          repositoryId={repositoryId}
          close={() => setOpen(false)}
        />
      )}
    </div>
  );
};

const ViberMemory = ({
  profileId,
  name,
  repositoryId,
  close,
}: {
  profileId: string;
  name: string;
  repositoryId?: string | null;
  close: () => void;
}) => {
  const [facts, setFacts] = useState<ViberMemoryFact[]>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("");
  const [repoScope, setRepoScope] = useState<string | null>(repositoryId ?? null);
  const [editing, setEditing] = useState<string>();
  const [forgetting, setForgetting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const scope = { profile_id: profileId };
  const editingFact = facts?.find(({ id }) => id === editing);
  const availableRepo = editingFact?.repository_id ?? repositoryId;
  const title = `Private memory for ${name}`;

  useEffect(() => {
    let active = true;

    void viberMemoryRpc("viber.memory.list", { profile_id: profileId }).then(
      (saved) => {
        if (active) {
          setFacts(saved);
        }
      },
      (reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      },
    );

    return () => {
      active = false;
    };
  }, [loadAttempt, profileId]);

  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!facts || busy || !text.trim()) {
      return;
    }

    void mutate(async () => {
      const body = { ...scope, text, topic: topic.trim() || null, repository_id: repoScope };
      if (editing) {
        const saved = await viberMemoryRpc("viber.memory.update", { ...body, id: editing });
        setFacts(facts.map((fact) => (fact.id === saved.id ? saved : fact)));
      } else {
        const saved = await viberMemoryRpc("viber.memory.create", body);
        setFacts([...facts, saved]);
      }

      setEditing(undefined);
      setText("");
      setTopic("");
      setRepoScope(repositoryId ?? null);
    });
  };

  const forget = (id: string) => {
    if (!facts || busy) {
      return;
    }

    void mutate(async () => {
      await viberMemoryRpc("viber.memory.forget", { ...scope, id });
      setFacts(facts.filter((fact) => fact.id !== id));
      setForgetting(undefined);
    });
  };

  return (
    <WorkspaceOverlay label={title} onClose={close} className="viber-memory-overlay">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <Button size="sm" onClick={close}>
          Close
        </Button>
      </header>
      {error && (
        <p role="alert" className="my-3 text-accent-red">
          {error}
        </p>
      )}
      {facts ? (
        <>
          <form
            className="my-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <label htmlFor="viber-memory-fact">{editing ? "Correct fact" : "New fact"}</label>
            <textarea
              id="viber-memory-fact"
              ref={field}
              rows={3}
              maxLength={viberMemoryFactLimit}
              value={text}
              disabled={busy || !!forgetting}
              onChange={(event) => setText(event.target.value)}
            />
            <label htmlFor="viber-memory-topic">Topic for recall (optional)</label>
            <input
              id="viber-memory-topic"
              value={topic}
              maxLength={80}
              disabled={busy || !!forgetting}
              onChange={(event) => setTopic(event.target.value)}
            />
            {availableRepo && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={repoScope === availableRepo}
                  disabled={busy || !!forgetting}
                  onChange={(event) => setRepoScope(event.target.checked ? availableRepo : null)}
                />
                Limit recall to {editingFact?.repository_label ?? "this repository"}
              </label>
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="default"
                busy={busy && !forgetting}
                disabled={!text.trim() || !!forgetting}
              >
                {editing ? "Save correction" : "Save fact"}
              </Button>
              {editing && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setEditing(undefined);
                    setText("");
                    setTopic("");
                    setRepoScope(repositoryId ?? null);
                    setError("");
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </div>
          </form>
          {facts.length ? (
            <ul aria-label="Saved facts" className="grid gap-2">
              {facts.map((fact) => (
                <li key={fact.id} className="grid gap-2 border-t border-border-default pt-2">
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{fact.text}</p>
                  <p className="text-sm text-ink-muted">
                    {fact.needs_review
                      ? "Possible conflict · excluded from recall"
                      : [
                          fact.repository_label ??
                            (fact.repository_id ? "Saved repository" : undefined),
                          fact.topic,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "Private panel only"}
                  </p>
                  {fact.source && (
                    <details className="text-sm text-ink-muted">
                      <summary>
                        Learned from your message on{" "}
                        {new Date(fact.source.created_at).toLocaleDateString()}
                      </summary>
                      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {fact.source.evidence}
                      </p>
                    </details>
                  )}
                  {fact.shared?.map(({ provider, at, earlier_revision }) => (
                    <p className="text-sm text-ink-muted" key={`${provider}:${earlier_revision}`}>
                      {earlier_revision ? "Earlier version shared" : "Shared"} with{" "}
                      {provider === "codex" ? "Codex" : "Antigravity"} on{" "}
                      {new Date(at).toLocaleDateString()}
                    </p>
                  ))}
                  <div className="flex flex-wrap items-center gap-2">
                    {forgetting === fact.id ? (
                      <>
                        <span>Forget this fact?</span>
                        <Button
                          size="sm"
                          variant="destructive"
                          busy={busy}
                          onClick={() => forget(fact.id)}
                        >
                          Confirm forget
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setForgetting(undefined);
                            setError("");
                          }}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          disabled={busy || !!editing || !!forgetting}
                          onClick={() => {
                            setText(fact.text);
                            setTopic(fact.topic ?? "");
                            setRepoScope(fact.repository_id ?? null);
                            setEditing(fact.id);
                            setError("");
                            field.current?.focus();
                          }}
                        >
                          Correct
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy || !!editing || !!forgetting}
                          onClick={() => {
                            setForgetting(fact.id);
                            setError("");
                          }}
                        >
                          Forget
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted">No saved facts.</p>
          )}
        </>
      ) : error ? (
        <Button
          size="sm"
          onClick={() => {
            setError("");
            setLoadAttempt((attempt) => attempt + 1);
          }}
        >
          Retry loading facts
        </Button>
      ) : (
        <p role="status" className="my-3">
          Loading facts…
        </p>
      )}
    </WorkspaceOverlay>
  );
};
