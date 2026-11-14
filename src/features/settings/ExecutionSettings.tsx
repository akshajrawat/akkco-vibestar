import type { DesktopInfo } from "../../../electron/contracts";
import { Select } from "../../components/ui/Select";

export const ExecutionSettings = ({
  desktop,
  setDesktop,
  flush,
}: {
  desktop: DesktopInfo | null;
  setDesktop: (desktop: DesktopInfo) => void;
  root?: string;
  busy?: boolean;
  installLog?: string;
  install?: () => Promise<void>;
  flush?: () => Promise<void>;
}) => (
  <section className="settings-section execution-settings">
    <h2>Execution environment</h2>
    <div className="settings-fields">
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
  </section>
);
