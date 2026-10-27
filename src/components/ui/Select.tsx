import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

/** A viewport-bounded picker with searchable options and one keyboard focus owner. */
export const Select = ({
  value,
  options,
  onChange,
  label,
  placeholder = "Select…",
  disabled = false,
  searchable = false,
  id,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  id?: string;
}) => {
  const generated = useId();
  const listId = `${generated}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLInputElement | HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(value);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260, maxHeight: 300 });
  const selected = options.find((option) => option.value === value);

  const filtered = options.filter((option) =>
    `${option.label} ${option.description || ""}`.toLowerCase().includes(query.toLowerCase()),
  );

  const available = filtered.filter((option) => !option.disabled);
  const current = available.find((option) => option.value === active) || available[0];
  const activeId = current ? `${listId}-${options.indexOf(current)}` : undefined;

  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  };

  const show = () => {
    setQuery("");
    setActive(value);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 18;
      const above = rect.top - 18;

      const contentHeight =
        (popup.current?.querySelector(".select-options")?.scrollHeight || 0) +
        (popup.current?.querySelector(".select-search")?.getBoundingClientRect().height || 0) +
        12;

      const desiredHeight = Math.min(360, contentHeight || 360);
      const useBelow = below >= Math.min(desiredHeight, above);
      const maxHeight = Math.min(desiredHeight, useBelow ? below : above);
      const top = useBelow ? rect.bottom + 6 : Math.max(12, rect.top - maxHeight - 6);

      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top,
        width,
        maxHeight,
      });
    };

    place();
    keyboard.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const dismiss = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };

    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);

  const choose = (option: SelectOption) => {
    if (option.disabled || disabled || trigger.current?.matches(":disabled")) return;
    onChange(option.value);
    close();
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        data-value={value}
        className="select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            show();
            if (event.key === "Home")
              setActive(options.find((option) => !option.disabled)?.value || "");
            if (event.key === "End")
              setActive([...options].reverse().find((option) => !option.disabled)?.value || "");
          }
        }}
      >
        {selected?.icon}
        <span className="select-value">
          <span>{selected?.label || placeholder}</span>
          {selected?.description && <small>{selected.description}</small>}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="select-popover"
            style={position}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (event.key === "Tab") {
                close();
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const index = available.findIndex((option) => option.value === current?.value);

                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? available.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + available.length) %
                        available.length;

                if (available[next]) setActive(available[next].value);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (current) choose(current);
              }
            }}
          >
            {searchable && (
              <div className="select-search">
                <Search size={14} aria-hidden="true" />
                <input
                  ref={(element) => {
                    keyboard.current = element;
                  }}
                  role="combobox"
                  aria-label={`Search ${label.toLowerCase()}`}
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={activeId}
                  placeholder="Search…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            )}
            <div
              id={listId}
              ref={
                searchable
                  ? undefined
                  : (element) => {
                      keyboard.current = element;
                    }
              }
              role="listbox"
              aria-label={label}
              tabIndex={searchable ? undefined : 0}
              aria-activedescendant={searchable ? undefined : activeId}
              className="select-options"
            >
              {filtered.map((option) => (
                <div
                  id={`${listId}-${options.indexOf(option)}`}
                  key={option.value}
                  data-value={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  className={`select-option${current === option ? " active" : ""}`}
                  onPointerMove={() => !option.disabled && setActive(option.value)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  {option.icon}
                  <span className="select-value">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  {option.value === value && <Check size={14} aria-hidden="true" />}
                </div>
              ))}
              {!filtered.length && (
                <p className="select-empty" role="status">
                  No matches found
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};
