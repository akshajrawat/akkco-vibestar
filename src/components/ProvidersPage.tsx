import { useState, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { RefreshCw, Plug, CheckCircle2 } from "lucide-react";
import { useProviders } from "../lib/useWorkspace";
import { rpc, errorMessage, subscribe } from "../lib/api";
import { Button } from "./ui/button";
export const ProvidersPage = () => {
  const { providers, loading, error, refresh } = useProviders();
  const [localError, setError] = useState("");
  const [session, setSession] = useState("");
  const [loginProvider, setProvider] = useState("");
  const [connecting, setConnecting] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const sessionRef = useRef("");
  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Consolas, monospace",
      theme: { background: "#101217", foreground: "#d4d4d8" },
      convertEol: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (container.current) {
      term.open(container.current);
      fit.fit();
    }
    terminal.current = term;
    const subscription = subscribe((e) => {
      if (
        e.event === "auth.output" &&
        (!sessionRef.current || e.session_id === sessionRef.current)
      )
        term.write(e.text || "");
      if (e.event === "auth.closed" && e.session_id === sessionRef.current) {
        term.writeln(
          "\r\nOfficial login process ended. Refresh provider status.",
        );
        sessionRef.current = "";
        setSession("");
        void refresh();
      }
    });
    const input = term.onData((text) => {
      if (sessionRef.current)
        void rpc("auth.input", { session_id: sessionRef.current, text }).catch(
          (e) => setError(errorMessage(e)),
        );
    });
    const observer = new ResizeObserver(() => fit.fit());
    if (container.current) observer.observe(container.current);
    return () => {
      void subscription.then((fn) => fn());
      if (sessionRef.current)
        void rpc("auth.close", { session_id: sessionRef.current });
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [refresh]);
  const connect = async (provider: string) => {
    setConnecting(true);
    setError("");
    setProvider(provider);
    terminal.current?.clear();
    try {
      if (sessionRef.current)
        await rpc("auth.close", { session_id: sessionRef.current });
      sessionRef.current = "";
      const v = await rpc<{ session_id: string }>("auth.connect", { provider });
      sessionRef.current = v.session_id;
      setSession(v.session_id);
      terminal.current?.focus();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setConnecting(false);
    }
  };
  return (
    <div className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">OFFICIAL CLI SUBSCRIPTIONS</span>
          <h1>Providers</h1>
        </div>
        <Button disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={13} />
          {loading ? "Detecting…" : "Refresh status"}
        </Button>
      </div>
      {(error || localError) && (
        <div className="error-box">{error || localError}</div>
      )}
      <div className="providers-grid">
        {providers.map((p) => (
          <section className="provider-card" key={p.provider}>
            <h2>
              {p.provider === "codex" ? "OpenAI Codex" : "Google Antigravity"}
            </h2>
            <div className="provider-status">
              <CheckCircle2
                size={14}
                className={p.installed ? "success" : "failure"}
              />
              {p.installed ? "Installed" : "Not installed"}
              <code>{p.version}</code>
            </div>
            <p>{p.authentication}</p>
            {p.error && <div className="warning-box">{p.error}</div>}
            <div className="capabilities">
              {p.capabilities.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <Button
              onClick={() => void connect(p.provider)}
              disabled={!p.installed || connecting}
            >
              <Plug size={13} />
              Connect {p.provider === "codex" ? "Codex" : "Antigravity"}
            </Button>
            <details>
              <summary>Available models ({p.models.length})</summary>
              {p.models.length ? (
                <pre>{p.models.join("\n")}</pre>
              ) : (
                <p className="subtle">
                  No stable model-list command exposed. Configure a model slug;
                  CLI errors are surfaced without substitution.
                </p>
              )}
            </details>
          </section>
        ))}
      </div>
      <section className="auth-panel">
        <div className="panel-heading">
          <strong>
            Official login terminal {loginProvider && `· ${loginProvider}`}
          </strong>
          <span>{session ? "Active PTY" : "Connect a provider to begin"}</span>
        </div>
        <div ref={container} className="auth-terminal" />
        <p className="subtle">
          Credentials remain owned by the CLI. Login terminal output is not
          stored. Antigravity exposes no login subcommand in this version;
          Connect opens its official interactive CLI.
        </p>
        {session && (
          <Button
            onClick={() =>
              void rpc("auth.close", { session_id: session }).then(() => {
                sessionRef.current = "";
                setSession("");
              })
            }
          >
            Close login terminal
          </Button>
        )}
      </section>
    </div>
  );
};
