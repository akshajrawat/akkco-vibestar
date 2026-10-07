import { useState } from "react";
import { RefreshCw, CheckCircle2, Plug } from "lucide-react";
import { useProviders } from "../lib/useWorkspace";
import { rpc } from "../lib/api";
import { AuthDialog } from "./AuthDialog";
import { Button } from "./ui/button";
export const ProvidersPage = () => {
  const { providers, loading, error, refresh } = useProviders();
  const [login, setLogin] = useState("");
  return (
    <div className="page providers-page">
      <div className="page-title">
        <h1>Providers</h1>
        <Button disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={13} />
          {loading ? "Detecting…" : "Refresh"}
        </Button>
      </div>
      {error && <p className="error-box">{error}</p>}
      <div className="provider-list">
        {providers.map((p) => {
          const name =
            p.provider === "github"
              ? "GitHub"
              : p.provider === "codex"
                ? "OpenAI Codex"
                : "Google Antigravity";
          const connected = p.authentication.startsWith("Connected");
          return (
            <section className="provider-row" key={p.provider}>
              <div className="provider-icon">
                <Plug size={18} />
              </div>
              <div className="provider-info">
                <h2>{name}</h2>
                <p className={connected ? "success" : "subtle"}>
                  {connected && <CheckCircle2 size={12} />} {p.authentication}
                </p>
                <details>
                  <summary>
                    {p.version || "CLI not installed"}
                    {p.models.length ? ` · ${p.models.length} models` : ""}
                  </summary>
                  {p.error && <p className="warning-box">{p.error}</p>}
                  {p.models.length > 0 && <pre>{p.models.join("\n")}</pre>}
                  <p className="subtle">{p.capabilities.join(" · ")}</p>
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
          done={() => {
            const wasGithub = login === "github";
            setLogin("");
            void refresh();
            if (wasGithub) void rpc("github.sync");
          }}
        />
      )}
    </div>
  );
};
