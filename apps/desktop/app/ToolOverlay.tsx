import { X } from "lucide-react";
import type { Snapshot, WorkspaceTool } from "../lib/types";
import { ListSkeleton, PageHeader } from "../components/ui/PageHeader";
import { Button } from "../components/ui/button";
import { WorkspaceOverlay } from "../components/ui/WorkspaceOverlay";
import { ProvidersPage } from "../features/providers/ProvidersPage";
import { RepositoryPage } from "../features/repositories/RepositoryPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { UsageView } from "../features/usage/UsageView";

export const ToolOverlay = ({
  tool,
  snapshot,
  refresh,
  error,
  close,
}: {
  tool: WorkspaceTool;
  snapshot: Snapshot | null;
  refresh: () => Promise<void>;
  error: string;
  close: () => void;
}) => {
  if (tool === "Settings") {
    return (
      <SettingsPage
        settings={snapshot?.settings}
        snapshot={snapshot || undefined}
        refresh={refresh}
        close={close}
      />
    );
  }

  return (
    <WorkspaceOverlay label={tool} className="tool-overlay" onClose={close}>
      <header className="flex shrink-0 items-center justify-between gap-3 px-5 py-3">
        <h2 className="text-[15px] font-semibold">{tool}</h2>
        <Button size="icon" variant="ghost" aria-label={`Close ${tool}`} onClick={close}>
          <X size={17} aria-hidden="true" />
        </Button>
      </header>
      {tool === "Usage" && <UsageView />}
      {tool === "Providers" && <ProvidersPage />}
      {tool === "Repositories" &&
        (snapshot ? (
          <RepositoryPage snapshot={snapshot} refresh={refresh} />
        ) : (
          <div className="page p-6">
            <PageHeader
              title="Repositories"
              description={error || "Connecting to the execution environment…"}
            />
            {!error && <ListSkeleton label="Loading saved repositories" />}
          </div>
        ))}
    </WorkspaceOverlay>
  );
};
