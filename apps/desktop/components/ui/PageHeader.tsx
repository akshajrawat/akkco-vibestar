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
  <header
    className={`page-header mb-6.5 flex min-h-7.5 flex-wrap items-start justify-between gap-3 ${className}`}
  >
    <div className="min-w-[220px] flex-1">
      <h1 className="whitespace-nowrap text-[24px] leading-[1.3] tracking-[-0.7px]">{title}</h1>
      <p className="mt-1.5 max-w-[680px] text-ink-muted">{description}</p>
    </div>
    {actions && <div className="flex gap-2 items-center flex-wrap">{actions}</div>}
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
  <section className="flex [&>.button]:mt-2 flex-col items-center justify-center gap-3 px-6 py-[clamp(32px,_7vh,_80px)] text-center">
    <div
      className="mb-1 grid size-14 place-items-center rounded-[16px] bg-surface-elevated text-ink-secondary"
      aria-hidden="true"
    >
      {icon}
    </div>
    <h2 className="text-[19px] tracking-[-0.3px]">{title}</h2>
    <p className="max-w-[460px] text-ink-muted">{description}</p>
    {action}
  </section>
);

export const ListSkeleton = ({ label }: { label: string }) => (
  <div className="list-skeleton" role="status" aria-label={label}>
    {[0, 1, 2].map((row) => (
      <div
        className="mb-3 flex gap-4 rounded-panel bg-surface-panel p-6"
        key={row}
        aria-hidden="true"
      >
        <div className="size-10 animate-skeleton rounded-control bg-surface-hover" />
        <div className="flex-1">
          <div className="mb-3 h-3.5 w-[40%] animate-skeleton rounded-control bg-surface-hover" />
          <div className="h-2.5 w-[70%] animate-skeleton rounded-control bg-surface-hover" />
        </div>
      </div>
    ))}
    <span className="sr-only">{label}</span>
  </div>
);
