import type { DesktopInfo } from "../../../electron/contracts";
import { Select } from "../../components/ui/Select";
import { Button } from "../../components/ui/button";

export const ExecutionSettings = ({
  desktop,
  setDesktop,
  flush,
  install,
  busy,
  installLog,
}: {
  desktop: DesktopInfo | null;
  setDesktop: (desktop: DesktopInfo) => void;
  root?: string;
  busy?: boolean;
  installLog?: string;
  install?: () => Promise<void>;
  flush?: () => Promise<boolean>;
}) => (
  <section className="settings-section p-[8px_0_24px] execution-settings">
    <h2>Execution environment</h2>
    <div className="settings-fields grid grid-cols-[1fr_1fr] [@media(max-width:760px)]:grid-cols-[minmax(0,_1fr)] gap-[20px_24px] [align-items:start] max-w-[900px]">
      <label>
        WSL distribution
        <Select
          label="WSL distribution"
          value={desktop?.config.distro || desktop?.distros[0] || ""}
          disabled={!desktop?.native_windows}
          onChange={(distro) =>
            desktop &&
            setDesktop({
              ...desktop,
              config: { ...desktop.config, distro },
            })
          }
          options={[
            ...(desktop?.native_windows ? [{ value: "", label: "Select distribution" }] : []),
            ...(desktop?.distros.map((d) => ({ value: d, label: d })) || []),
          ]}
        />
      </label>

      <label>
        <span>
          Linux data directory <small>optional</small>
        </span>
        <input
          value={desktop?.config.data_home || ""}
          placeholder="Default: ~/.akkco-vibestar"
          onChange={(e) =>
            desktop &&
            setDesktop({
              ...desktop,
              config: {
                ...desktop.config,
                data_home: e.target.value,
              },
            })
          }
          onBlur={() => void flush?.()}
        />
      </label>

      {desktop?.native_windows && (
        <label>
          <span>
            Existing helper path <small>optional</small>
          </span>
          <input
            value={desktop.config.helper_path}
            placeholder="Use the installed bundled helper"
            onChange={(e) =>
              setDesktop({
                ...desktop,
                config: {
                  ...desktop.config,
                  helper_path: e.target.value,
                },
              })
            }
            onBlur={() => void flush?.()}
          />
        </label>
      )}
    </div>
    {desktop?.native_windows && (
      <details>
        <summary>Runtime troubleshooting</summary>
        <p>The bundled runtime is prepared automatically. Repair it here after a failed setup.</p>
        <Button disabled={busy} onClick={() => void install?.()}>
          Repair Runtime
        </Button>
        {installLog && (
          <pre className="install-log p-3 max-h-[200px] overflow-auto text-[11px]">
            {installLog}
          </pre>
        )}
      </details>
    )}
  </section>
);
