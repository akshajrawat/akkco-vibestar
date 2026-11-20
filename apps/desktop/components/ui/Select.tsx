import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { useOverlayPortal } from "./WorkspaceOverlay";

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
  navigation,
  details,
  popoverClassName = "",
  triggerAppearance = "default",
  selectedLabel,
  selectedIcon,
  listNotice,
  emptyMessage = "No matches found",
  closeOnSelect = true,
  onOpenChange,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  id?: string;
  navigation?: ReactNode;
  details?: ReactNode;
  popoverClassName?: string;
  triggerAppearance?: "default" | "chip";
  selectedLabel?: ReactNode;
  selectedIcon?: ReactNode;
  listNotice?: ReactNode;
  emptyMessage?: string;
  closeOnSelect?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const overlay = useOverlayPortal();
  const generated = useId();
  const listId = `${generated}-options`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLInputElement | HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(value);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 260, maxHeight: 300 });
  const selected = options.find((option) => option.value === value);
  const expanded = Boolean(details);

  const filtered = options.filter((option) =>
    `${option.label} ${option.description || ""}`.toLowerCase().includes(query.toLowerCase()),
  );

  const available = filtered.filter((option) => !option.disabled);
  const current = available.find((option) => option.value === active) || available[0];
  const activeId = current ? `${listId}-${options.indexOf(current)}` : undefined;

  const close = useCallback(
    (restore = true) => {
      if (!opened.current) {
        return;
      }

      opened.current = false;
      setOpen(false);
      onOpenChange?.(false);
      if (restore) {
        trigger.current?.focus();
      }
    },
    [onOpenChange],
  );

  const show = () => {
    opened.current = true;
    setQuery("");
    setActive(value);
    setOpen(true);
    onOpenChange?.(true);
  };

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const width = Math.min(Math.max(rect.width, expanded ? 548 : 260), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 18;
      const above = rect.top - 18;

      const contentHeight =
        (popup.current?.querySelector(".select-options")?.scrollHeight || 0) +
        (popup.current?.querySelector(".select-search")?.getBoundingClientRect().height || 0) +
        12;

      const desiredHeight = Math.min(
        360,
        expanded ? Math.max(contentHeight, 320) : contentHeight || 360,
      );

      const useBelow = below >= Math.min(desiredHeight, above);
      const maxHeight = Math.min(desiredHeight, useBelow ? below : above);
      const top = useBelow ? rect.bottom + 6 : Math.max(12, rect.top - maxHeight - 6);

      setPosition({
        left: Math.max(
          12,
          Math.min(expanded ? rect.right - width : rect.left, window.innerWidth - width - 12),
        ),
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
  }, [open, expanded]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const dismiss = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      ) {
        close(false);
      }
    };

    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, close]);

  useEffect(() => {
    if (open && activeId) {
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, activeId]);

  const choose = (option: SelectOption) => {
    if (option.disabled || disabled || trigger.current?.matches(":disabled")) {
      return;
    }

    onChange(option.value);
    if (closeOnSelect) {
      close();
    }
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        data-value={value}
        className={`select-trigger flex w-full min-w-0 items-center gap-2 rounded-input text-left text-foreground border-0 [transition:background_var(--motion-fast)] ${
          triggerAppearance === "chip"
            ? "select-trigger-chip"
            : "bg-surface-hover px-[11px] py-[9px] [&:hover:not(:disabled)]:bg-surface-selected"
        }`}
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
            if (event.key === "Home") {
              setActive(options.find((option) => !option.disabled)?.value || "");
            }

            if (event.key === "End") {
              setActive([...options].reverse().find((option) => !option.disabled)?.value || "");
            }
          }
        }}
      >
        {selectedIcon || selected?.icon}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 [&>*]:truncate">
          <span>{selectedLabel || selected?.label || placeholder}</span>
          {!selectedLabel && selected?.description && <small>{selected.description}</small>}
        </span>
        {triggerAppearance === "default" && <ChevronDown size={14} aria-hidden="true" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className={`select-popover fixed z-[1500] flex flex-col overflow-hidden rounded-panel border-0 bg-surface-elevated p-[5px] [box-shadow:0_12px_40px_var(--shadow)] animate-[surface-enter_var(--motion-enter)_ease-out] ${popoverClassName}`}
            style={position}
            onMouseDown={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (
                (navigation || details) &&
                event.relatedTarget !== trigger.current &&
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                close(false);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              } else if (event.key === "Tab" && !navigation && !details) {
                close();
              } else if (event.target !== keyboard.current) {
                return;
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

                if (available[next]) {
                  setActive(available[next].value);
                }
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (current) {
                  choose(current);
                }
              }
            }}
          >
            {navigation}
            <div className="flex flex-1 flex-col min-w-0 min-h-0">
              {searchable && (
                <div className="select-search flex items-center gap-2 p-[4px_9px_8px] text-muted">
                  <Search size={14} aria-hidden="true" />
                  <input
                    className="rounded-none bg-transparent px-0 py-[5px] [border:0] [box-shadow:none] [outline:none] [&:hover]:bg-transparent"
                    ref={(element) => {
                      keyboard.current = element;
                    }}
                    role="combobox"
                    aria-label={`Search ${label.toLowerCase()}`}
                    aria-autocomplete="list"
                    aria-expanded="true"
                    aria-controls={listId}
                    aria-activedescendant={activeId}
                    placeholder={expanded ? "Search models…" : "Search…"}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              )}
              {listNotice}
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
                className="select-options min-h-0 overflow-auto overscroll-contain px-0 py-1 focus-visible:[outline:1px_solid_var(--focus-ring)] focus-visible:outline-offset-[-1px] focus-visible:rounded-control"
              >
                {filtered.map((option) => (
                  <div
                    id={`${listId}-${options.indexOf(option)}`}
                    key={option.value}
                    data-value={option.value}
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    className={`select-option flex items-center rounded-control gap-[9px] p-[9px] mx-0 my-[1px] min-w-0 cursor-pointer aria-disabled:cursor-not-allowed aria-selected:font-[550] aria-disabled:text-ink-disabled ${current === option ? "bg-surface-hover" : ""}`}
                    onPointerMove={() => !option.disabled && setActive(option.value)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                  >
                    {option.icon}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 [&>*]:truncate">
                      <span>{option.label}</span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {option.value === value && <Check size={14} aria-hidden="true" />}
                  </div>
                ))}
                {!filtered.length && (
                  <p className="p-4 text-muted text-center" role="status">
                    {options.length ? "No matches found" : emptyMessage}
                  </p>
                )}
              </div>
            </div>
            {details}
          </div>,
          overlay?.current || document.body,
        )}
    </>
  );
};
