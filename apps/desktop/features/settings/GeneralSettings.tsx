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
    <section className="settings-section settings-general-section">
      <h2>Task</h2>
      <div className="settings-card">
        <label className="settings-row">
          <span>
            Default editor
            <small>Choose the editor used to open task worktrees and repository checkouts.</small>
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
            <small>Set how many tasks can run at the same time across your workspace.</small>
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
    <section className="settings-section settings-general-section">
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
  </>
);
