import { useState } from "react";
import { RefreshCw, CheckCircle2 } from "lucide-react";

import { useProviders } from "../../hooks/useWorkspace";
import { AuthDialog } from "./AuthDialog";
import { Button } from "../../components/ui/button";
import { PageHeader, ListSkeleton } from "../../components/ui/PageHeader";
import { ProviderIcon } from "../../components/ui/ProviderIcon";

export const ProvidersPage = () => {
  const { providers, loading, error, refresh } = useProviders();
  const [login, setLogin] = useState("");
  return (
    <div className="page px-[clamp(20px,_3vw,_48px)] py-7.5 flex-1 min-h-0 providers-page">
      <PageHeader
        title="Providers"
        description="Connect your developer tools through their official command-line sign-in."
        actions={
          <button
            type="button"
            className="ghost-action-button inline-flex items-center gap-1.5 [border:0] px-2.5 py-1.5 text-[12px] font-medium [transition:background_var(--motion-fast),_color_var(--motion-fast)] disabled:opacity-50 focus-visible:[outline:1px_solid_var(--focus-ring)] focus-visible:outline-offset-[2px]"
            disabled={loading}
            onClick={() => void refresh()}
            aria-label="Refresh providers"
          >
            <RefreshCw size={13} className={loading ? "spinning" : ""} aria-hidden="true" />
            <span>{loading ? "Detecting installed CLIs…" : "Refresh"}</span>
          </button>
        }
      />
      {error && (
        <p className="error-box px-3 py-2 mx-0 my-2 text-[12px] whitespace-pre-wrap wrap-anywhere">
          {error}
        </p>
      )}
      {loading && !providers.length && <ListSkeleton label="Detecting providers" />}
      <div className="provider-list grid gap-3.5">
        {providers.map((p) => {
          const name =
            p.provider === "github"
              ? "GitHub"
              : p.provider === "codex"
                ? "OpenAI Codex"
                : "Google Antigravity";

          const connected = p.connected;

          return (
            <section
              className="provider-row flex items-start gap-3.5 p-6 border border-border-subtle"
              key={p.provider}
            >
              <div className="provider-icon border border-border-default grid place-items-center text-ink-secondary">
                <ProviderIcon provider={p.provider} size={20} />
              </div>

              <div className="provider-info flex-1 min-w-0">
                <h2>{name}</h2>
                <p className={connected ? "success" : "subtle"}>
                  {connected && <CheckCircle2 size={12} />}{" "}
                  {connected ? "Connected" : p.installed ? "Not connected" : "CLI not installed"}
                </p>
                {p.accountLabel && <p className="subtle">{p.accountLabel}</p>}
                {p.error && <p className="warning">{p.error}</p>}
                <details>
                  <summary>
                    {p.models.length ? `${p.models.length} available models` : "Model availability"}
                  </summary>
                  <p className="subtle">{p.version || "CLI not installed"}</p>
                  <p className="subtle">
                    {p.capabilities.join(" · ") || "Capabilities unavailable"}
                  </p>

                  {p.models.length > 0 && (
                    <pre>
                      {p.models
                        .map((m) => `${m.label || m.id} · ${m.supportedEfforts.join(", ")}`)
                        .join("\n")}
                    </pre>
                  )}
                  {!p.models.length && <p className="subtle">No models reported by this CLI.</p>}
                </details>
              </div>

              {connected ? (
                <button
                  type="button"
                  className="ghost-action-button inline-flex items-center gap-1.5 [border:0] px-2.5 py-1.5 text-[12px] font-medium [transition:background_var(--motion-fast),_color_var(--motion-fast)] disabled:opacity-50 focus-visible:[outline:1px_solid_var(--focus-ring)] focus-visible:outline-offset-[2px]"
                  disabled={!p.installed || !!login}
                  onClick={() => setLogin(p.provider)}
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>Reconnect</span>
                </button>
              ) : (
                <Button disabled={!p.installed || !!login} onClick={() => setLogin(p.provider)}>
                  {`Connect ${p.provider === "github" ? "GitHub" : p.provider === "codex" ? "Codex" : "Antigravity"}`}
                </Button>
              )}
            </section>
          );
        })}
      </div>

      <p className="provider-footnote text-ink-muted text-[11px]">
        Subscriptions and authentication are managed by the official CLIs in your execution
        environment.
      </p>

      {login && (
        <AuthDialog
          provider={login}
          initiallyConnected={providers.find((p) => p.provider === login)?.connected}
          done={() => {
            setLogin("");
            void refresh();
          }}
        />
      )}
    </div>
  );
};
