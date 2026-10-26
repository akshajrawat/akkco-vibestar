import type { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTaskView, updateTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";

export const ActionTray = ({
  id,
  label,
  title,
  detail,
  children,
}: {
  id: string;
  label: string;
  title: string;
  detail?: string;
  children: ReactNode;
}) => {
  const view = useTaskView(id);
  return (
    <section className="approval-tray" aria-label={label}>
      <div>
        <strong>{title}</strong>
        {!view.approvalCompact && detail && <small>{detail}</small>}
      </div>
      <Button
        size="icon"
        variant="ghost"
        aria-label={
          view.approvalCompact ? "Expand approval explanation" : "Minimize approval explanation"
        }
        aria-expanded={!view.approvalCompact}
        onClick={() => updateTaskView(id, { approvalCompact: !view.approvalCompact })}
      >
        {view.approvalCompact ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </Button>
      {children}
    </section>
  );
};
