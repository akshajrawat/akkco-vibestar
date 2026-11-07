import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import type { HistoricalWorkspace } from "../../../backend/flows/workspace";
import type { Detail } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { LogView } from "../chat/LogView";
import { UsageView } from "../usage/UsageView";
import { ImportedHistory } from "./ImportedHistory";
import { HistoricalChecks } from "./HistoricalChecks";

/** Recovery keeps historical records inspectable while withholding untranslatable execution. */
export const HistoricalTask = ({ detail, back }: { detail: Detail; back: () => void }) => {
  const [history, setHistory] = useState<HistoricalWorkspace>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("history");

  useEffect(() => {
    let alive = true;

    void rpc<HistoricalWorkspace>("flow.history", { task_id: detail.task.id })
      .then((value) => {
        if (alive) setHistory(value);
      })
      .catch((reason) => {
        if (alive) setError(errorMessage(reason));
      });

    return () => {
      alive = false;
    };
  }, [detail.task.id]);

  return (
    <div className="viber-workspace">
      <header className="viber-workspace-header">
        <Button size="icon" variant="ghost" aria-label="Back to tasks" onClick={back}>
          <ArrowLeft size={16} />
        </Button>
        <strong>Historical task · recovery needed</strong>
      </header>
      <p className="flow-inline-error" role="status">
        {error ||
          history?.migration.diagnostic ||
          "Restore the original ownership or task records from a backup, or create a new task. Files and retained history have been preserved."}
      </p>
      <nav className="flow-toolbar" aria-label="Historical task views">
        {["history", "checks", "logs", "usage"].map((value) => (
          <Button
            key={value}
            variant={tab === value ? "secondary" : "ghost"}
            onClick={() => setTab(value)}
          >
            {value}
          </Button>
        ))}
      </nav>
      <div className="viber-workspace-body">
        {tab === "history" ? (
          <ImportedHistory history={history} detail={detail} />
        ) : tab === "logs" ? (
          <LogView taskId={detail.task.id} runs={detail.runs} events={detail.events} />
        ) : tab === "usage" ? (
          <UsageView taskId={detail.task.id} records={detail.usage} />
        ) : (
          <HistoricalChecks detail={detail} />
        )}
      </div>
    </div>
  );
};
