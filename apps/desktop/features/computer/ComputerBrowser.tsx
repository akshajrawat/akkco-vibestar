import { useState, useEffect, type FormEvent } from "react";
import { RotateCw, Globe, ArrowRight } from "lucide-react";
import { Button } from "../../components/ui/button";
import { LOCAL_BROWSER_URL_REGEX } from "../../../core/computers/contracts";

export const ComputerBrowser = ({ profileId, active }: { profileId: string; active: boolean }) => {
  const [urlInput, setUrlInput] = useState(() => {
    return (
      localStorage.getItem(`vibestar.computerBrowserUrl.${profileId}`) || "http://127.0.0.1:3000"
    );
  });

  const [currentUrl, setCurrentUrl] = useState(() => {
    return (
      localStorage.getItem(`vibestar.computerBrowserUrl.${profileId}`) || "http://127.0.0.1:3000"
    );
  });

  const [error, setError] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const saved =
      localStorage.getItem(`vibestar.computerBrowserUrl.${profileId}`) || "http://127.0.0.1:3000";

    setUrlInput(saved);
    setCurrentUrl(saved);
    setError("");
  }, [profileId]);

  const navigateTo = (target: string) => {
    const trimmed = target.trim();
    if (!trimmed) {
      setError("Enter a local URL to browse.");
      return;
    }

    const fullUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    if (!LOCAL_BROWSER_URL_REGEX.test(fullUrl)) {
      setError(
        "Only local web services (http://127.0.0.1:* or http://localhost:*) can be opened for human sign-in takeover.",
      );

      return;
    }

    setError("");
    setUrlInput(fullUrl);
    setCurrentUrl(fullUrl);
    localStorage.setItem(`vibestar.computerBrowserUrl.${profileId}`, fullUrl);
    setReloadKey((prev) => prev + 1);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigateTo(urlInput);
  };

  const reload = () => {
    setReloadKey((prev) => prev + 1);
  };

  return (
    <div
      className="flex flex-1 flex-col min-h-0 bg-surface-panel overflow-hidden"
      role="tabpanel"
      aria-label="Browser"
      hidden={!active}
    >
      <div className="flex flex-col gap-1.5 p-2 border-b border-b-border-subtle bg-surface-elevated">
        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
          <Globe size={13} className="shrink-0 text-accent-cyan" />
          <span>
            Human-only local browser view &amp; sign-in takeover. Agent access is disabled.
          </span>
        </div>
        <form onSubmit={onSubmit} className="flex items-center gap-1.5">
          <input
            type="text"
            className="flex-1 min-w-0 px-2 py-1 text-[12px] bg-surface rounded-[var(--radius)] text-ink placeholder:text-ink-muted outline-none focus-visible:ring-1 focus-visible:ring-accent-primary"
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              if (error) {
                setError("");
              }
            }}
            placeholder="http://127.0.0.1:3000"
            aria-label="Browser URL"
          />
          <Button size="sm" type="submit" aria-label="Go to URL">
            <ArrowRight size={13} />
          </Button>
          <Button size="sm" variant="ghost" onClick={reload} aria-label="Reload browser view">
            <RotateCw size={13} />
          </Button>
        </form>
        <div className="flex items-center gap-1 text-[11px] text-ink-muted">
          <span>Local shortcuts:</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[11px]"
            onClick={() => {
              navigateTo("http://127.0.0.1:3000");
            }}
          >
            :3000
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[11px]"
            onClick={() => {
              navigateTo("http://127.0.0.1:5173");
            }}
          >
            :5173
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[11px]"
            onClick={() => {
              navigateTo("http://127.0.0.1:8080");
            }}
          >
            :8080
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-[11px] text-accent-red m-0">
            {error}
          </p>
        )}
      </div>
      <div className="flex-1 min-h-[200px] flex flex-col bg-white overflow-hidden relative">
        <iframe
          key={`${currentUrl}-${reloadKey}`}
          title="Viber browser view"
          src={currentUrl}
          sandbox="allow-scripts allow-forms allow-same-origin allow-popups-to-escape-sandbox"
          className="w-full flex-1 border-0"
        />
      </div>
    </div>
  );
};
