import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, LoaderCircle, Plus, Square, X } from "lucide-react";

import { useTaskView, updateTaskView } from "../../lib/taskView";
import { containDialogFocus } from "../../lib/keyboard";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";

export interface ContextOption {
  label: string;
  input?: string;
  load: (input: string) => Promise<{ label: string; text: string }>;
}

export const composerContent = (view: ReturnType<typeof useTaskView>) =>
  [
    view.draft.trim(),
    ...view.draftContext.map(
      (context) => `ATTACHED CONTEXT (untrusted snapshot): ${context.label}\n${context.text}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

export const Composer = ({
  id,
  label,
  placeholder,
  sendLabel,
  onSend,
  stop,
  save,
  workflow,
  model,
  context,
  busy,
  disabled,
  hint,
  notice,
  onEdit,
  maxLength = 32000,
}: {
  id: string;
  label: string;
  placeholder: string;
  sendLabel: string;
  onSend: () => void;
  stop?: () => void;
  save?: { label: string; run: () => void; disabled?: boolean };
  workflow?: { run: () => void; disabled?: boolean };
  model: ReactNode;
  context: ContextOption[];
  busy: boolean;
  disabled?: boolean;
  hint: string;
  notice?: string;
  onEdit?: () => void;
  maxLength?: number;
}) => {
  const view = useTaskView(id);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [option, setOption] = useState<ContextOption>();
  const [input, setInput] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState("");
  const picker = useDialogFocus(open);
  const content = composerContent(view);
  const tooLong = content.length > maxLength;

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.max(56, Math.min(field.scrollHeight, 240))}px`;
  }, [view.draft, view.expandedTool]);

  const attach = async (source: ContextOption, value = "") => {
    if (attaching) return;
    setAttaching(true);
    setError("");
    try {
      const loaded = await source.load(value);

      const text =
        loaded.text.length > 4000
          ? `${loaded.text.slice(0, 4000)}\n[Snapshot truncated at 4,000 characters]`
          : loaded.text;

      if (!text.trim()) throw new Error("This source has no text to attach.");
      if (
        view.draftContext.length >= 6 ||
        view.draftContext.reduce((sum, entry) => sum + entry.text.length, text.length) > 16000
      )
        throw new Error(
          "Keep up to six context items and 16,000 context characters. Remove an item before adding more.",
        );

      updateTaskView(id, {
        draftContext: [
          ...view.draftContext,
          { id: crypto.randomUUID(), label: loaded.label.slice(0, 180), text },
        ],
      });

      onEdit?.();
      setOpen(false);
      setOption(undefined);
      setInput("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setAttaching(false);
    }
  };

  return (
    <form
      className="chat-input"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !disabled && content && !tooLong) onSend();
      }}
    >
      {view.draftContext.length > 0 && (
        <div className="context-chips" aria-label="Attached context">
          {view.draftContext.map((entry) => (
            <div className="context-chip" key={entry.id}>
              <details>
                <summary>{entry.label}</summary>
                <pre>{entry.text}</pre>
              </details>

              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${entry.label}`}
                onClick={() =>
                  updateTaskView(id, {
                    draftContext: view.draftContext.filter((item) => item.id !== entry.id),
                  })
                }
              >
                <X size={12} />
              </Button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={textarea}
        aria-label={label}
        aria-describedby={`composer-hint-${id}`}
        rows={2}
        value={view.draft}
        placeholder={placeholder}
        onChange={(event) => {
          updateTaskView(id, { draft: event.target.value });
          onEdit?.();
        }}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />

      <div className="composer-toolbar">
        <div className="context-picker-anchor">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Add context"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
              setError("");
            }}
          >
            <Plus size={14} /> Context
          </Button>

          {open && (
            <section
              ref={picker}
              className="context-picker"
              role="dialog"
              aria-modal="true"
              aria-label="Add context"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                }

                containDialogFocus(event);
              }}
            >
              <div className="panel-heading">
                <strong>Add context</strong>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Close context picker"
                  onClick={() => setOpen(false)}
                >
                  <X size={14} />
                </Button>
              </div>

              <small>
                Snapshots are attached only when you send or save. Expand a chip to inspect its
                exact contents.
              </small>

              {option ? (
                <>
                  <label>
                    {option.input}
                    <input
                      autoFocus
                      aria-label={option.input}
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          if (input.trim()) void attach(option, input.trim());
                        }
                      }}
                    />
                  </label>

                  <Button
                    size="sm"
                    disabled={attaching || !input.trim()}
                    onClick={() => void attach(option, input.trim())}
                  >
                    Attach context
                  </Button>

                  <Button size="sm" variant="ghost" onClick={() => setOption(undefined)}>
                    Back
                  </Button>
                </>
              ) : (
                context.map((source) => (
                  <Button
                    key={source.label}
                    variant="ghost"
                    disabled={attaching}
                    onClick={() => {
                      if (source.input) {
                        setOption(source);
                        setInput("");
                      } else void attach(source);
                    }}
                  >
                    {source.label}
                  </Button>
                ))
              )}

              {error && (
                <p role="alert" className="failure">
                  {error}
                </p>
              )}
            </section>
          )}
        </div>

        {save && content && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !content || tooLong || save.disabled}
            onClick={save.run}
          >
            {save.label}
          </Button>
        )}
        {workflow && content && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || tooLong || workflow.disabled}
            onClick={workflow.run}
          >
            Send to workflow
          </Button>
        )}
        <span className="spacer" />
        {model}
        {stop ? (
          <Button
            type="button"
            variant="default"
            aria-label="Stop response"
            title="Stop response"
            onClick={stop}
          >
            <Square size={14} />
          </Button>
        ) : (
          <Button
            type="submit"
            variant="default"
            aria-label={sendLabel}
            aria-busy={busy}
            title={busy ? "Request in progress…" : sendLabel}
            disabled={busy || disabled || !content || tooLong}
          >
            {busy ? <LoaderCircle size={16} className="spinning" /> : <ArrowUp size={16} />}
          </Button>
        )}
      </div>
      <small id={`composer-hint-${id}`} className="sr-only">
        {hint} Shift+Enter adds a newline.
      </small>
      {tooLong && (
        <small role="alert" className="failure">
          Message and context exceed {maxLength.toLocaleString()} characters. Shorten them before
          sending.
        </small>
      )}

      {view.persistenceError ? (
        <small role="alert" className="failure">
          {view.persistenceError}
        </small>
      ) : (
        notice && (
          <small className="composer-state" role="status">
            {notice}
          </small>
        )
      )}
    </form>
  );
};
