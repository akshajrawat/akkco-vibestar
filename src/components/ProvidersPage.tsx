import { useState } from "react";
import {
  RefreshCw,
  CheckCircle2,
  Plug,
  Terminal,
  Github,
  Sparkles,
} from "lucide-react";
import { useProviders } from "../lib/useWorkspace";
import { AuthDialog } from "./AuthDialog";
import { Button } from "./ui/button";
import { PageHeader, ListSkeleton } from "./ui/PageHeader";
export const ProvidersPage = () => {
  const { providers, loading, error, refresh } = useProviders();
  const [login, setLogin] = useState("");
  return (
    <div className="page providers-page">
      <PageHeader
        title="Providers"
        description="Connect your developer tools through their official command-line sign-in."
        actions={
          <Button busy={loading} onClick={() => void refresh()}>
            {!loading && <RefreshCw size={14} />}
            {loading ? "Detecting installed CLIs…" : "Refresh"}
          </Button>
        }
      />
      {error && <p className="error-box">{error}</p>}
      {loading && !providers.length && (
        <ListSkeleton label="Detecting providers" />
      )}
      <div className="provider-list">
        {providers.map((p) => {
          const name =
            p.provider === "github"
              ? "GitHub"
              : p.provider === "codex"
                ? "OpenAI Codex"
                : "Google Antigravity";
          const connected = p.connected;
          const Icon =
            p.provider === "github"
              ? Github
              : p.provider === "codex"
                ? Terminal
                : p.provider === "antigravity"
                  ? Sparkles
                  : Plug;
          return (
            <section className="provider-row" key={p.provider}>
              <div className="provider-icon">
                <Icon size={20} />
              </div>
              <div className="provider-info">
                <h2>{name}</h2>
                <p className={connected ? "success" : "subtle"}>
                  {connected && <CheckCircle2 size={12} />}{" "}
                  {connected
                    ? "Connected"
                    : p.installed
                      ? "Not connected"
                      : "CLI not installed"}
                </p>
                {p.accountLabel && <p className="subtle">{p.accountLabel}</p>}
                <p className="subtle">{p.version || "CLI not installed"}</p>
                {p.error && <p className="warning">{p.error}</p>}
                <p className="subtle">
                  {p.capabilities.join(" · ") || "Capabilities unavailable"}
                </p>
                <details>
                  <summary>
                    {p.models.length
                      ? `${p.models.length} available models`
                      : "Model availability"}
                  </summary>
                  {p.models.length > 0 && (
                    <pre>
                      {p.models
                        .map(
                          (m) =>
                            `${m.label || m.id} · ${m.supportedEfforts.join(", ")}`,
                        )
                        .join("\n")}
                    </pre>
                  )}
                  {!p.models.length && (
                    <p className="subtle">No models reported by this CLI.</p>
                  )}
                </details>
              </div>
              <Button
                disabled={!p.installed || !!login}
                onClick={() => setLogin(p.provider)}
              >
                {connected
                  ? "Reconnect"
                  : `Connect ${p.provider === "github" ? "GitHub" : p.provider === "codex" ? "Codex" : "Antigravity"}`}
              </Button>
            </section>
          );
        })}
      </div>
      <p className="provider-footnote">
        Subscriptions and authentication are managed by the official CLIs in
        your execution environment.
      </p>
      {login && (
        <AuthDialog
          provider={login}
          initiallyConnected={
            providers.find((p) => p.provider === login)?.connected
          }
          done={() => {
            setLogin("");
            void refresh();
          }}
        />
      )}
    </div>
  );
};
