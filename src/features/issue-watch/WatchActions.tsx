import { useEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, ArchiveRestore, Archive } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useDialogFocus } from "../../hooks/useDialogFocus";

export const WatchActions = ({
  disabled,
  archived,
  edit,
  archive,
}: {
  disabled: boolean;
  archived: boolean;
  edit: () => void;
  archive: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const menu = useDialogFocus(open);

  useEffect(() => {
    if (!open) return;

    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  return (
    <div className="watch-actions-menu" ref={container}>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Watch actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={16} />
      </Button>
      {open && (
        <section
          ref={menu}
          className="watch-actions-popover"
          role="menu"
          aria-label="Watch actions"
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
              }

              setOpen(false);
            } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);

              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;

              items[next]?.focus();
            }
          }}
        >
          <Button
            variant="ghost"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              edit();
            }}
          >
            <Pencil size={14} /> Edit
          </Button>
          <Button
            variant={archived ? "ghost" : "destructive"}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              archive();
            }}
          >
            {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{" "}
            {archived ? "Restore" : "Archive"}
          </Button>
        </section>
      )}
    </div>
  );
};
