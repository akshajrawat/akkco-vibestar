import { Plus } from "lucide-react";

import { Button } from "../../components/ui/button";
import { ViberFace } from "./ViberFace";

export const ViberWelcome = ({
  create,
  disabled,
  hasVibers = false,
}: {
  create: () => void;
  disabled: boolean;
  hasVibers?: boolean;
}) => (
  <section className="viber-welcome-page" aria-label="Vibers">
    <div className="viber-welcome-guide">
      <ViberFace className="viber-idle" />
      <h1>{hasVibers ? "Your Vibers" : "Create your first Viber"}</h1>
      <p>
        {hasVibers
          ? "Choose a Viber in the sidebar, or create someone new."
          : "Give it a name, a look and a way to help."}
      </p>
      <Button variant="default" disabled={disabled} onClick={create}>
        <Plus size={16} />
        Create a Viber
      </Button>
    </div>
  </section>
);
