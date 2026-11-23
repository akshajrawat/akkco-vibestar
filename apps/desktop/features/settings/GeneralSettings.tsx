import type { Settings } from "../../lib/types";
import { Select } from "../../components/ui/Select";

const memoryModels = [
  {
    key: "embedding_model",
    label: "Local embedding model",
    help: "Ranks related facts with Ollama on this computer.",
  },
  {
    key: "suggestion_model",
    label: "Local suggestion model",
    help: "Optional. Used when the provider has no structured suggestion for the turn.",
  },
] as const;

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
    <section className="settings-section p-[8px_0_24px] settings-general-section">
      <h2>Viber Memory</h2>
      <div className="settings-card">
        {(
          [
            [
              "automatic_saving",
              "Automatic saving",
              "Remember useful facts you state in Viber conversations.",
            ],
            ["recall", "Recall", "Search saved facts locally before eligible turns."],
          ] as const
        ).map(([key, label, help]) => (
          <label className="settings-row" key={key}>
            <span>
              {label}
              <small>{help}</small>
            </span>
            <input
              type="checkbox"
              aria-label={label}
              checked={value.viber_memory[key]}
              onChange={(event) =>
                setValue({
                  ...value,
                  viber_memory: { ...value.viber_memory, [key]: event.target.checked },
                })
              }
            />
          </label>
        ))}
        {(
          [
            ["codex", "Codex"],
            ["antigravity", "Antigravity"],
          ] as const
        ).map(([provider, label]) => (
          <label className="settings-row" key={provider}>
            <span>
              Share recalled facts with {label}
              <small>Allow this provider to receive relevant facts when recall is enabled.</small>
            </span>
            <input
              type="checkbox"
              aria-label={`Share recalled facts with ${label}`}
              checked={value.viber_memory.share_with[provider]}
              onChange={(event) =>
                setValue({
                  ...value,
                  viber_memory: {
                    ...value.viber_memory,
                    share_with: {
                      ...value.viber_memory.share_with,
                      [provider]: event.target.checked,
                    },
                  },
                })
              }
            />
          </label>
        ))}
        {memoryModels.map(({ key, label, help }) => (
          <label className="settings-row" key={key}>
            <span>
              {label}
              <small>{help}</small>
            </span>
            <input
              type="text"
              aria-label={label}
              key={value.viber_memory[key]}
              maxLength={128}
              spellCheck={false}
              className="min-w-0 rounded-control bg-surface-hover px-2 py-1 hover:bg-surface-selected"
              defaultValue={value.viber_memory[key]}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => {
                const model = event.currentTarget.value.trim();
                if (model !== value.viber_memory[key]) {
                  setValue({ ...value, viber_memory: { ...value.viber_memory, [key]: model } });
                }
              }}
            />
          </label>
        ))}
      </div>
      <p className="text-sm text-ink-muted">
        Use installed models in Ollama with cloud features disabled. Start a fresh provider thread
        to leave previously shared facts behind.
      </p>
    </section>
  </>
);
