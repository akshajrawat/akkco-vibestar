import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
export const TitleBar = ({ onPalette }: { onPalette?: () => void } = {}) => {
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    void window.electronWindow
      .isMaximized()
      .then((value) => {
        if (mounted) setMaximized(value);
      })
      .catch((e) => setError(String(e)));
    const unsubscribe = window.electronWindow.onMaximizedChanged(setMaximized);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const control = (action: () => Promise<void>) =>
    void action().catch((e) => setError(String(e)));
  return (
    <header className="titlebar">
      <span className="titlebar-name">akkco vibestar</span>
      {onPalette && (
        <button
          className="titlebar-palette"
          aria-label="Open command palette"
          onClick={onPalette}
        >
          Search tasks and commands <kbd>Ctrl+Shift+P</kbd>
        </button>
      )}
      {error && (
        <span role="alert" className="titlebar-error">
          {error}
        </span>
      )}
      <div className="window-controls" aria-label="Window controls">
        <button
          aria-label="Minimize window"
          onClick={() => control(window.electronWindow.minimize)}
        >
          <Minus size={14} />
        </button>
        <button
          aria-label={maximized ? "Restore window" : "Maximize window"}
          onClick={() => control(window.electronWindow.maximize)}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          className="window-close"
          aria-label="Close window"
          onClick={() => control(window.electronWindow.close)}
        >
          <X size={15} />
        </button>
      </div>
    </header>
  );
};
