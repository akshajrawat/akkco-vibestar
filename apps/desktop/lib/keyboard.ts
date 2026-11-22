import type { KeyboardEvent } from "react";

export const containDialogFocus = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "Tab") {
    return;
  }

  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex='0']",
    ),
  ];

  const boundary = event.shiftKey ? controls[0] : controls.at(-1);
  if (document.activeElement === boundary) {
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
  }
};
