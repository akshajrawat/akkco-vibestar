import { Monitor } from "lucide-react";
import { Button } from "../../components/ui/button";

export const ComputerTurnOption = ({
  enabled,
  change,
  disabled,
}: {
  enabled: boolean;
  change: (enabled: boolean) => void;
  disabled?: boolean;
}) => (
  <Button
    size="sm"
    variant={enabled ? "secondary" : "ghost"}
    aria-pressed={enabled}
    aria-label="Use Shared Computer for next message"
    title="Use Shared Computer files and local services for the next message"
    disabled={disabled}
    onClick={() => change(!enabled)}
  >
    <Monitor size={14} aria-hidden="true" /> Computer
  </Button>
);
