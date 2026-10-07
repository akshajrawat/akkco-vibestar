import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { rpc, subscribe, errorMessage } from "../lib/api";
import { Button } from "./ui/button";
export const AuthDialog = ({
  provider,
  done,
}: {
  provider: string;
  done: () => void;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  const finish = useRef(done);
  finish.current = done;
  useEffect(() => {
    let alive = true;
    let session = "";
    const pending = new Map<string, string[]>();
    const closed = new Set<string>();
    const checkSuccess = () => {
      setEnded(true);
      void rpc<import("../lib/types").Detection[]>("providers.detect")
        .then((providers) => {
          if (
            alive &&
            providers
              .find((p) => p.provider === provider)
              ?.authentication.startsWith("Connected")
          )
            finish.current();
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    };
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "Cascadia Code, Consolas, monospace",
      convertEol: true,
      theme: { background: "#181818", foreground: "#d4d7df" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (container.current) {
      term.open(container.current);
      fit.fit();
    }
    const sub = subscribe((e) => {
      if (!alive || !e.session_id) return;
      if (e.event === "auth.output") {
        if (e.session_id === session) term.write(e.text || "");
        else
          pending.set(e.session_id, [
            ...(pending.get(e.session_id) || []),
            e.text || "",
          ]);
      }
      if (e.event === "auth.closed") {
        closed.add(e.session_id);
        if (e.session_id === session) {
          checkSuccess();
        }
      }
    });
    void sub
      .then(() => rpc<{ session_id: string }>("auth.connect", { provider }))
      .then((value) => {
        session = value.session_id;
        if (!alive) {
          void rpc("auth.close", { session_id: session });
          return;
        }
        for (const text of pending.get(session) || []) term.write(text);
        pending.clear();
        setEnded(closed.has(session));
        if (closed.has(session)) checkSuccess();
        term.focus();
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    const input = term.onData((text) => {
      if (session && !closed.has(session))
        void rpc("auth.input", { session_id: session, text }).catch((e) => {
          if (alive) setError(errorMessage(e));
        });
    });
    const observer = new ResizeObserver(() => {
      if (container.current?.clientHeight) fit.fit();
    });
    if (container.current) observer.observe(container.current);
    return () => {
      alive = false;
      void sub.then((fn) => fn());
      if (session) void rpc("auth.close", { session_id: session });
      observer.disconnect();
      input.dispose();
      term.dispose();
    };
  }, [provider]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${provider}`}
      >
        <div className="modal-heading">
          <h2>
            Connect{" "}
            {provider === "github"
              ? "GitHub"
              : provider === "codex"
                ? "Codex"
                : "Antigravity"}
          </h2>
          <Button variant="ghost" onClick={done}>
            Done
          </Button>
        </div>
        <p className="subtle">
          Complete the official CLI login. Credentials stay with the provider.
        </p>
        <div ref={container} className="auth-terminal" />
        {error && (
          <p role="alert" className="error-box">
            {error}
          </p>
        )}
        {ended && (
          <p className="subtle">
            Login process ended. Select Done to refresh your connection.
          </p>
        )}
      </section>
    </div>
  );
};
