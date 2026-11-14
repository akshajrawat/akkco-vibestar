import toast from "react-hot-toast";
import { CircleCheck, CircleAlert, TriangleAlert, Info, LoaderCircle, X } from "lucide-react";

import type { Settings } from "./types";
import { errorMessage } from "./api";
import { Button } from "../components/ui/button";

type Kind = "success" | "error" | "warning" | "information" | "progress";

type Options = {
  id?: string;
  essential?: boolean;
  action?: { label: string; run: () => void | Promise<void> };
};

const preferenceKey = "vibestar.notificationPreference";

const cachedPreference = (): Settings["notification_preference"] => {
  try {
    return localStorage.getItem(preferenceKey) === "all" ? "all" : "necessary";
  } catch {
    return "necessary";
  }
};

let preference = cachedPreference();
const recent = new Map<string, { message: string; at: number; essential: boolean }>();

const notify = (kind: Kind, message: string, options: Options = {}) => {
  const id = options.id || `${kind}:${message}`;
  const essential = kind === "error" || options.essential === true;
  if (!essential && preference !== "all") {
    toast.dismiss(id);
    return id;
  }

  const previous = recent.get(id);
  if (previous?.message === message && Date.now() - previous.at < 10000) return id;
  for (const [key, entry] of recent) if (Date.now() - entry.at > 60000) recent.delete(key);
  recent.set(id, { message, at: Date.now(), essential });

  const Icon = {
    success: CircleCheck,
    error: CircleAlert,
    warning: TriangleAlert,
    information: Info,
    progress: LoaderCircle,
  }[kind];

  toast(
    (current) => (
      <div
        className={`notification notification-${kind}`}
        aria-hidden={!current.visible}
        inert={!current.visible}
      >
        <Icon size={19} aria-hidden="true" className={kind === "progress" ? "spinning" : ""} />
        <div className="notification-content">
          <span>{message}</span>
          {options.action && (
            <Button
              size="sm"
              onClick={() => {
                toast.dismiss(id);
                recent.delete(id);

                void Promise.resolve()
                  .then(options.action!.run)
                  .catch((error) => {
                    notify("error", errorMessage(error), { ...options, id });
                  });
              }}
            >
              {options.action.label}
            </Button>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss notification"
          onClick={() => toast.dismiss(id)}
        >
          <X size={15} />
        </Button>
      </div>
    ),
    {
      id,
      duration: kind === "progress" || options.action ? Infinity : kind === "error" ? 10000 : 5000,
      ariaProps: {
        role: kind === "error" ? "alert" : "status",
        "aria-live": kind === "error" ? "assertive" : "polite",
      },
    },
  );

  return id;
};

/** All application notifications share preference filtering, identity and retry behavior. */
export const notifications = {
  success: (message: string, options?: Options) => notify("success", message, options),
  error: (message: string, options?: Options) => notify("error", message, options),
  warning: (message: string, options?: Options) => notify("warning", message, options),
  information: (message: string, options?: Options) => notify("information", message, options),
  progress: (message: string, options?: Options) => notify("progress", message, options),
  dismiss: (id: string) => {
    toast.dismiss(id);
    recent.delete(id);
  },
  setPreference: (next: Settings["notification_preference"]) => {
    preference = next;
    try {
      localStorage.setItem(preferenceKey, next);
    } catch {
      /* This display cache never replaces authoritative core settings. */
    }

    if (next === "necessary")
      for (const [id, entry] of recent) if (!entry.essential) toast.dismiss(id);
  },
};
