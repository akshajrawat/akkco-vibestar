import type { ReactNode } from "react";

export const PageHeader = ({
  title,
  description,
  actions,
  className = "",
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  className?: string;
}) => (
  <header className={`page-title page-header ${className}`}>
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>
);

export const EmptyState = ({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) => (
  <section className="empty-state">
    <div className="empty-state-icon" aria-hidden="true">
      {icon}
    </div>
    <h2>{title}</h2>
    <p>{description}</p>
    {action}
  </section>
);

export const ListSkeleton = ({ label }: { label: string }) => (
  <div className="list-skeleton" role="status" aria-label={label}>
    {[0, 1, 2].map((row) => (
      <div className="skeleton-row" key={row} aria-hidden="true">
        <div className="skeleton skeleton-icon" />
        <div>
          <div className="skeleton skeleton-title" />
          <div className="skeleton skeleton-description" />
        </div>
      </div>
    ))}
    <span className="sr-only">{label}</span>
  </div>
);
