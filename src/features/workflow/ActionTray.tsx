import type { ReactNode } from "react";

export const ActionTray = ({
  label,
  title,
  detail,
  children,
}: {
  id?: string;
  label: string;
  title: string;
  detail?: string;
  children: ReactNode;
}) => {
  return (
    <section className="approval-tray" aria-label={label}>
      <div>
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </div>
      {children}
    </section>
  );
};
