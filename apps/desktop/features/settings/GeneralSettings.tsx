import { defaultViberMemorySettings } from "../../../core/vibers/memory-contracts";
import type { Settings } from "../../lib/types";
import { Select } from "../../components/ui/Select";

export const GeneralSettings = ({
  value,
  setValue,
  editors,
}: {
  value: Settings;
  setValue: (value: Settings) => void;
  editors: { id: string; label: string }[];
}) => (
  <>
    <section className="settings-section p-[8px_0_24px] settings-general-section">
      <h2>Viber Workspaces</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span>
            Default editor
            <small>Choose the editor used to open Viber worktrees and repository checkouts.</small>
          </span>
          <Select
            label="Default editor"
            value={value.default_editor}
            onChange={(editor) =>
              setValue({ ...value, default_editor: editor as Settings["default_editor"] })
            }
            options={[
              { value: "", label: "Choose when opening" },
              ...editors.map((editor) => ({ value: editor.id, label: editor.label })),
              ...(value.default_editor &&
              !editors.some((editor) => editor.id === value.default_editor)
                ? [{ value: value.default_editor, label: `${value.default_editor} (unavailable)` }]
                : []),
            ]}
          />
        </label>
        <label className="settings-row">
          <span>
            Concurrency
            <small>
              Set how many concurrent runs can execute at the same time across your workspace.
            </small>
          </span>
          <Select
            label="Concurrency"
            value={String(value.concurrency)}
            onChange={(concurrency) => setValue({ ...value, concurrency: Number(concurrency) })}
            options={[1, 2, 3, 4].map((item) => ({ value: String(item), label: String(item) }))}
          />
        </label>
      </div>
    </section>
    <section className="settings-section p-[8px_0_24px] settings-general-section">
      <h2>Notifications</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span>
            Notification preference
            <small>Errors, required input and blocking runtime updates always appear.</small>
          </span>
          <Select
            label="Notification preference"
            value={value.notification_preference}
            onChange={(preference) =>
              setValue({
                ...value,
                notification_preference: preference as Settings["notification_preference"],
              })
            }
            options={[
              { value: "necessary", label: "Necessary only" },
              { value: "all", label: "All notifications" },
            ]}
          />
        </label>
      </div>
    </section>
    <section
      className="settings-section p-[8px_0_24px] settings-general-section"
      aria-labelledby="enable-memory"
    >
      <h2 id="enable-memory">Enable Memory</h2>
      <div className="settings-card">
        <div className="settings-row grid-cols-[minmax(0,1fr)_auto]!">
          <p id="enable-memory-description" className="font-normal text-ink-muted">
            Viber remembers important things from your chats and gets better at helping you over
            time.
          </p>
          <button
            type="button"
            role="switch"
            aria-labelledby="enable-memory"
            aria-describedby="enable-memory-description"
            aria-checked={value.viber_memory.automatic_saving || value.viber_memory.recall}
            className="group relative h-6 w-11 shrink-0 rounded-full bg-neutral-950 aria-checked:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={() => {
              const enabled = !(value.viber_memory.automatic_saving || value.viber_memory.recall);

              setValue({
                ...value,
                viber_memory: {
                  ...value.viber_memory,
                  automatic_saving: enabled,
                  recall: enabled,
                  embedding_model:
                    enabled && !value.viber_memory.embedding_model
                      ? defaultViberMemorySettings.embedding_model
                      : value.viber_memory.embedding_model,
                  suggestion_model:
                    enabled && !value.viber_memory.suggestion_model
                      ? defaultViberMemorySettings.suggestion_model
                      : value.viber_memory.suggestion_model,
                },
              });
            }}
          >
            <span className="absolute top-0.5 left-0.5 size-5 rounded-full bg-neutral-500 transition-transform group-aria-checked:translate-x-5 group-aria-checked:bg-neutral-400 motion-reduce:transition-none" />
          </button>
        </div>
      </div>
    </section>
  </>
);
