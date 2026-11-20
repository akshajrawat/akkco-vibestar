import { useRef, useState } from "react";
import { Search } from "lucide-react";
import { useDialogFocus } from "../hooks/useDialogFocus";

export interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  run: () => void;
}

export const CommandPalette = ({
  actions,
  close,
}: {
  actions: PaletteAction[];
  close: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useDialogFocus();

  const filtered = actions.filter((a) =>
    `${a.label} ${a.detail || ""}`.toLowerCase().includes(query.toLowerCase()),
  );

  const execute = (action: PaletteAction) => {
    close();
    action.run();
  };

  return (
    <div
      className="palette-backdrop fixed inset-[var(--titlebar-height)_0_0] z-[100] flex justify-center pt-[55px] items-start"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <section
        ref={dialog}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        className="command-palette max-w-[90vw] border border-border-strong [box-shadow:0_12px_40px_var(--overlay)] overflow-hidden"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }

          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((i) => (filtered.length ? (i + 1) % filtered.length : 0));
          }

          if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
          }

          if (e.key === "Enter" && filtered[selected]) {
            e.preventDefault();
            execute(filtered[selected]);
          }

          if (e.key === "Tab") {
            e.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <div className="palette-search flex gap-[9px] items-center px-[13px] py-2.5 border-b border-b-border">
          <Search size={16} />
          <input
            ref={input}
            aria-label="Search commands"
            placeholder="Search commands or vibers…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
          />
          <kbd>Esc</kbd>
        </div>

        <div role="listbox" aria-label="Available commands">
          {filtered.map((action, index) => (
            <button
              role="option"
              aria-selected={index === selected}
              key={action.id}
              className={selected === index ? "selected" : ""}
              onMouseEnter={() => setSelected(index)}
              onClick={() => execute(action)}
            >
              <span>{action.label}</span>
              <small>{action.detail}</small>
            </button>
          ))}
          {!filtered.length && (
            <p className="px-1.5 py-3 text-[12px] text-ink-muted">No matching commands</p>
          )}
        </div>
      </section>
    </div>
  );
};
