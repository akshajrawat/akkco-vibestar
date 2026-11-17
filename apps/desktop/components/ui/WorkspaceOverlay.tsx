import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

const OverlayPortal = createContext<RefObject<HTMLDialogElement | null> | null>(null);

/** Keep popovers in the active modal's top layer, where they remain interactive. */
export const useOverlayPortal = () => useContext(OverlayPortal);

/** Native modality makes the mounted workspace inert and owns focus containment. */
export const WorkspaceOverlay = ({
  label,
  onClose,
  children,
  className = "",
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();

    return () => {
      element.close();

      // Nested confirmations must leave the top layer before the opener can receive focus.
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      });
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={`workspace-overlay ${className}`}
      aria-label={label}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!dialog.current?.querySelector('[role="dialog"]')) onClose();
      }}
      onKeyDown={(event) => {
        // Workspace shortcuts must not change the task beneath the modal.
        event.stopPropagation();
      }}
    >
      <OverlayPortal value={dialog}>{children}</OverlayPortal>
    </dialog>
  );
};
