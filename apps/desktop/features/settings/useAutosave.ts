import { useRef, useState } from "react";

import { errorMessage } from "../../lib/api";
import { notifications } from "../../lib/notifications";

/** Serialize patches so a failed field cannot leak into another field's later save. */
export const useAutosave = <T extends object>(
  initial: T,
  save: (value: T) => Promise<void>,
  label: string,
  persisted?: (value: T) => void,
) => {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const acknowledged = useRef(initial);
  const displayed = useRef(initial);
  const pending = useRef<Partial<T>>({});
  const saving = useRef<Promise<void> | null>(null);

  const show = (next: T) => {
    displayed.current = next;
    setValue(next);
  };

  const flush = (): Promise<void> => {
    if (saving.current) return saving.current;
    if (!Object.keys(pending.current).length) return Promise.resolve();
    setBusy(true);

    saving.current = Promise.resolve()
      .then(async () => {
        let failed = false;
        while (Object.keys(pending.current).length) {
          const patch = pending.current;
          pending.current = {};
          const target = { ...acknowledged.current, ...patch };
          try {
            await save(target);
            acknowledged.current = target;
            persisted?.(target);
          } catch (error) {
            failed = true;

            const cancelled =
              error && typeof error === "object" && "kind" in error && error.kind === "cancelled";

            if (!cancelled) {
              notifications.error(`Could not save ${label}: ${errorMessage(error)}`, {
                id: `settings:${label}`,
              });
            }
          }

          show({ ...acknowledged.current, ...pending.current });
        }

        if (!failed)
          notifications.success(`${label.charAt(0).toUpperCase()}${label.slice(1)} saved`, {
            id: `settings:${label}`,
          });
      })
      .finally(() => {
        saving.current = null;
        setBusy(false);
      });

    return saving.current;
  };

  return {
    value,
    busy,
    flush,
    update: (next: T) => {
      const patch: Partial<T> = {};
      for (const key of Object.keys(next) as (keyof T)[])
        if (JSON.stringify(next[key]) !== JSON.stringify(displayed.current[key]))
          patch[key] = next[key];
      if (!Object.keys(patch).length) return;
      pending.current = { ...pending.current, ...patch };
      show(next);
    },
    receive: (next: T) => {
      if (saving.current || Object.keys(pending.current).length) return;
      acknowledged.current = next;
      show(next);
    },
  };
};
