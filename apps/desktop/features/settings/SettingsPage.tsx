import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ChevronRight, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import type { Settings, Snapshot } from "../../lib/types";
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
  refresh,
  snapshot,
  close,
}: {
  settings?: Settings;
  refresh: () => Promise<void>;
  snapshot?: Snapshot;
  close: () => void;
}) => {
  const draft = useSettingsDraft(settings, refresh);
  const { value, setValue } = draft;
  const [section, setSection] = useState<SettingsCategory>("General");
  const [visited, setVisited] = useState<SettingsCategory[]>(["General"]);

  const savingOnClose = useRef<Promise<boolean> | null>(null);

  const flushOnClose = () => {
    savingOnClose.current ??= draft.flushOnClose().finally(() => {
      savingOnClose.current = null;
    });

    return savingOnClose.current;
  };

  const requestClose = async () => {
    if (!draft.hasPending() || (await flushOnClose())) {
      close();
    }
  };

  const saveBeforeClose = useEffectEvent((event: BeforeUnloadEvent) => {
    if (!draft.hasPending()) {
      return;
    }

    event.preventDefault();
    event.returnValue = false;

    void flushOnClose().then((saved) => {
      if (saved) {
        return window.electronWindow.close();
      }
    });
  });

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => saveBeforeClose(event);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const select = (category: SettingsCategory) => {
    setSection(category);
    setVisited((current) => (current.includes(category) ? current : [...current, category]));
  };

  return (
    <WorkspaceOverlay
      label="Settings"
      className="tool-overlay settings-workspace"
      onClose={() => void requestClose()}
      dismissOnBackdrop
    >
      <div className="settings-layout">
        <SettingsNavigation selected={section} select={select} />
        <div className="flex flex-col min-w-0 min-h-0">
          <header className="flex items-center justify-between shrink-0 gap-3 min-h-15.5 px-5.5 py-3 [@media(max-width:700px)]:px-3.5 [@media(max-width:700px)]:py-2.5 border-b border-b-border-subtle [@media(max-width:700px)]:flex-wrap">
            <div className="settings-breadcrumb flex items-center gap-2.5 text-ink-muted text-[12px]">
              <span>Settings</span>
              <ChevronRight size={13} aria-hidden="true" />
              <strong>{section}</strong>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close Settings"
              onClick={() => void requestClose()}
            >
              <X size={17} aria-hidden="true" />
            </Button>
          </header>
          {draft.error && (
            <div
              className="settings-feedback shrink-0 max-h-[22%] overflow-auto"
              aria-live="polite"
            >
              <p
                className="error-box px-3 py-2 mx-0 my-2 text-[12px] whitespace-pre-wrap wrap-anywhere"
                role="alert"
              >
                {draft.error}
              </p>
            </div>
          )}
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            {visited.map((category) => (
              <div
                className="settings-category overflow-auto overscroll-contain p-[28px_32px_36px] [@media(max-width:1100px)]:p-6 [@media(max-width:700px)]:px-4 [@media(max-width:700px)]:py-5 [scrollbar-gutter:stable]"
                key={category}
                id={`settings-${category.replaceAll(" ", "-")}`}
                hidden={section !== category}
              >
                <div className="min-w-0 [border:0] p-0 m-0">
                  {category === "General" &&
                    (value ? (
                      <GeneralSettings value={value} setValue={setValue} editors={draft.editors} />
                    ) : (
                      <p role="status">
                        Settings unavailable until the execution core connects. Inspect Execution to
                        configure the environment.
                      </p>
                    ))}
                  {category === "Providers" && (
                    <ProvidersPage
                      memorySharing={
                        value && {
                          allowed: value.viber_memory.share_with,
                          set: (provider, allowed) =>
                            setValue({
                              ...value,
                              viber_memory: {
                                ...value.viber_memory,
                                share_with: {
                                  ...value.viber_memory.share_with,
                                  [provider]: allowed,
                                },
                              },
                            }),
                        }
                      }
                    />
                  )}
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
