import { useEffect, useRef } from "react";

export const useDialogFocus = (enabled = true) => {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!enabled) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current
      ?.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']:not(:disabled)",
      )
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [enabled]);
  return dialog;
};
