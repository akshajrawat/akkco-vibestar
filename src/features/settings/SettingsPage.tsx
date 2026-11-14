import { useState } from "react";
import { ChevronRight, X } from "lucide-react";

import type { Settings, Snapshot } from "../../lib/types";
import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { ProvidersPage } from "../providers/ProvidersPage";
import { RepositoryPage } from "../repositories/RepositoryPage";
import { StoragePage } from "./StoragePage";
import { GeneralSettings } from "./GeneralSettings";
import { ExecutionSettings } from "./ExecutionSettings";
import { SettingsNavigation, type SettingsCategory } from "./SettingsNavigation";
import { useSettingsDraft } from "./useSettingsDraft";

/** Settings is independent of app navigation; panels automatically save changes. */
export const SettingsPage = ({
  settings,
  root,
  refresh,
  snapshot,
  close,
}: {
  settings?: Settings;
  root?: string;
  refresh: () => Promise<void>;
  diagnostics?: Snapshot["persistence"];
  snapshot?: Snapshot;
  close: () => void;
}) => {
  const draft = useSettingsDraft(settings, refresh);
  const { value, setValue } = draft;
  const [section, setSection] = useState<SettingsCategory>("General");
  const [visited, setVisited] = useState<SettingsCategory[]>(["General"]);

  const requestClose = () => {
    void draft.flush?.();
    close();
  };

  const select = (category: SettingsCategory) => {
    setSection(category);
    setVisited((current) => (current.includes(category) ? current : [...current, category]));
  };

  return (
    <WorkspaceOverlay label="Settings" className="settings-workspace" onClose={requestClose}>
      <div className="settings-layout">
        <SettingsNavigation selected={section} select={select} />
        <div className="settings-main">
          <header className="settings-header">
            <div className="settings-breadcrumb">
              <span>Settings</span>
              <ChevronRight size={13} aria-hidden="true" />
              <strong>{section}</strong>
            </div>
            <div className="settings-header-actions">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close Settings"
                onClick={requestClose}
              >
                <X size={17} />
              </Button>
            </div>
          </header>
          {draft.error && (
            <div className="settings-feedback" aria-live="polite">
              <p className="error-box" role="alert">
                {draft.error}
              </p>
            </div>
          )}
          <div className="settings-content">
            {visited.map((category) => (
              <div
                className="settings-category"
                key={category}
                id={`settings-${category.replaceAll(" ", "-")}`}
                hidden={section !== category}
              >
                <div className="settings-panel-fields">
                  {category === "General" &&
                    (value ? (
                      <GeneralSettings value={value} setValue={setValue} editors={draft.editors} />
                    ) : (
                      <p role="status">
                        Settings unavailable until the execution core connects. Inspect Execution to
                        configure the environment.
                      </p>
                    ))}
                  {category === "Providers" && <ProvidersPage />}
                  {category === "Repositories" && (
                    <>
                      {snapshot ? (
                        <RepositoryPage snapshot={snapshot} refresh={refresh} />
                      ) : (
                        <p role="status">Connect the execution core to manage repositories.</p>
                      )}
                    </>
                  )}
                  {category === "Execution" && (
                    <ExecutionSettings
                      desktop={draft.desktop}
                      setDesktop={draft.setDesktop}
                      flush={draft.flush}
                      root={root}
                      busy={draft.busy}
                      installLog={draft.installLog}
                      install={draft.install}
                    />
                  )}
                  {category === "Storage" && <StoragePage refresh={refresh} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </WorkspaceOverlay>
  );
};
