import type { Artifact } from "../lib/types";
export const PlanView = ({ artifacts }: { artifacts: Artifact[] }) => {
  const latest = (stage: number) =>
    [...artifacts].reverse().find((a) => a.stage === stage);
  return (
    <div className="plan-comparison">
      {[1, 2].map((stage) => {
        const saved = latest(stage);
        const result = saved
          ? (JSON.parse(saved.content) as Record<string, unknown>)
          : null;
        return (
          <section key={stage}>
            <div className="panel-heading">
              <strong>
                {stage === 1
                  ? "Antigravity original plan"
                  : "Codex refined plan"}
              </strong>
              <small>
                {saved
                  ? new Date(saved.created_at).toLocaleTimeString()
                  : "Awaiting stage"}
              </small>
            </div>
            {result ? (
              Object.entries(result).map(([key, value]) => (
                <div className="plan-section" key={key}>
                  <h3>{key.replace(/([A-Z])/g, " $1")}</h3>
                  {Array.isArray(value) ? (
                    value.length ? (
                      <ol>
                        {value.map((v, i) => (
                          <li key={i}>{String(v)}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="subtle">None</p>
                    )
                  ) : (
                    <p>{String(value)}</p>
                  )}
                </div>
              ))
            ) : (
              <p className="empty-row">This plan has not completed.</p>
            )}
          </section>
        );
      })}
    </div>
  );
};
