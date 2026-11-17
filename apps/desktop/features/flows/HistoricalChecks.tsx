import { useState } from "react";

import type { Detail } from "../../lib/types";
import { CommandRuns } from "../verification/CommandRuns";
import { HistoricalVerification } from "./HistoricalVerification";

/** Historical evidence stays inspectable without restoring retired workflow mutations. */
export const HistoricalChecks = ({ detail }: { detail: Detail }) => {
  const [commandId, setCommandId] = useState("");
  return (
    <section className="flow-activity" aria-label="Historical checks">
      <HistoricalVerification detail={detail} inspect={setCommandId} />
      <CommandRuns key={commandId} detail={detail} selectedId={commandId} />
    </section>
  );
};
