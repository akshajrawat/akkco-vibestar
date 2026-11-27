import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Monitor, RotateCw } from "lucide-react";
import {
  DesktopInputSchema,
  DesktopSize,
  type ComputerRpc,
} from "../../../core/computers/contracts";
import { Button } from "../../components/ui/button";
import { computerRpc, errorMessage } from "../../lib/api";

type Input = ComputerRpc["computer.desktop.input"]["input"]["input"];

const keyNames: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Escape: "Escape",
  Tab: "Tab",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  PageUp: "Prior",
  PageDown: "Next",
  " ": "space",
};

// Release the controller lease before the next desktop view acquires it.
let previousRelease = Promise.resolve<unknown>(undefined);

export const ComputerDesktop = () => {
  const [frame, setFrame] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<string>(null);
  const pending = useRef(Promise.resolve());
  const moving = useRef(false);
  const queued = useRef(0);
  const enterControl = useRef<HTMLButtonElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const controlHint = useId();

  useEffect(() => {
    const id = crypto.randomUUID();
    const scope = { controller_id: id };
    let active = true;
    let schedule: ReturnType<typeof setTimeout>;

    const load = async () => {
      try {
        const next = await computerRpc("computer.desktop.frame", scope);
        if (active) {
          setFrame(next);
          schedule = setTimeout(() => void load(), 160);
        }
      } catch (reason) {
        if (active) {
          setError(errorMessage(reason));
        }
      }
    };

    const connection = previousRelease
      .then(() => {
        if (active) {
          return computerRpc("computer.desktop.acquire", scope);
        }
      })
      .then(() => {
        if (active) {
          controller.current = id;
          return load();
        }
      })
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      active = false;
      controller.current = null;
      clearTimeout(schedule);

      previousRelease = connection
        .then(() => computerRpc("computer.desktop.release", scope))
        .catch(() => undefined);
    };
  }, [attempt]);

  const send = (input: Input) => {
    const id = controller.current;
    if (id && (queued.current < 64 || (input.type === "pointer" && input.phase === "up"))) {
      queued.current++;

      pending.current = pending.current
        .then(async () => {
          try {
            if (controller.current === id) {
              await computerRpc("computer.desktop.input", { controller_id: id, input });
            }
          } finally {
            queued.current--;
            if (input.type === "pointer" && input.phase === "move") {
              moving.current = false;
            }
          }
        })
        .catch((reason) => {
          if (controller.current === id) {
            setError(errorMessage(reason));
          }
        });

      return true;
    }

    return false;
  };

  const sendText = (text: string) => {
    const input = DesktopInputSchema.safeParse({ type: "text", text });
    if (input.success) {
      send(input.data);
    }
  };

  const keyboard = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (
      event.key === "F6" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      enterControl.current?.focus();
      return;
    }

    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      event.key === "Dead" ||
      event.key === "Process"
    ) {
      return;
    }

    const shortcut =
      !event.getModifierState("AltGraph") && (event.ctrlKey || event.metaKey || event.altKey);

    const key =
      (event.key !== " " || shortcut ? keyNames[event.key] : undefined) ||
      (/^F(?:[1-9]|1[0-2])$/.test(event.key) && event.key) ||
      (shortcut && /^[a-zA-Z0-9]$/.test(event.key) && event.key.toLowerCase());

    if (key) {
      event.preventDefault();

      const modified = [
        event.ctrlKey || event.metaKey ? "ctrl" : "",
        event.altKey ? "alt" : "",
        event.shiftKey ? "shift" : "",
        key,
      ];

      send({ type: "key", keys: modified.filter(Boolean).join("+") });
    }
  };

  const pointer = (
    event: { currentTarget: HTMLElement; clientX: number; clientY: number },
    phase: "down" | "up" | "click" | "move",
    button: number,
  ) => {
    const area = event.currentTarget.getBoundingClientRect();

    const x = Math.max(
      0,
      Math.min(
        DesktopSize.width - 1,
        Math.floor(((event.clientX - area.left) * DesktopSize.width) / area.width),
      ),
    );

    const y = Math.max(
      0,
      Math.min(
        DesktopSize.height - 1,
        Math.floor(((event.clientY - area.top) * DesktopSize.height) / area.height),
      ),
    );

    return send({ type: "pointer", phase, x, y, button });
  };

  const release = (event: PointerEvent<HTMLDivElement>) =>
    pointer(event, "up", [1, 2, 3][event.button] || 1);

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="rounded-xl border border-border-default p-4">
          <p role="alert" className="mb-3 text-sm">
            {error}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setError("");
              setFrame("");
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCw size={14} /> Reconnect desktop
          </Button>
        </div>
      ) : frame ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={enterControl}
              variant="secondary"
              aria-describedby={controlHint}
              onClick={() => textInput.current?.focus()}
            >
              Control desktop
            </Button>
            <p id={controlHint} className="text-xs text-ink-muted">
              Press F6 to return to Vibestar.
            </p>
          </div>
          <div
            className="relative overflow-hidden rounded-xl ring-1 ring-border-default focus-within:ring-2 focus-within:ring-current bg-black cursor-crosshair select-none"
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              event.preventDefault();
              textInput.current?.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              pointer(event, "down", [1, 2, 3][event.button] || 1);
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onPointerMove={(event) => {
              if (event.buttons && !moving.current) {
                moving.current = pointer(event, "move", 1);
              }
            }}
            onWheel={(event) => {
              if (event.deltaY) {
                pointer(event, "click", event.deltaY < 0 ? 4 : 5);
              }
            }}
          >
            <img
              draggable={false}
              className="block w-full"
              src={`data:image/jpeg;base64,${frame}`}
              alt="Live Shared Computer desktop"
            />
            <textarea
              ref={textInput}
              className="pointer-events-none absolute left-0 top-0 size-px opacity-0"
              aria-label="Shared Computer keyboard input"
              aria-describedby={controlHint}
              tabIndex={-1}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={keyboard}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(event) => {
                if (composing.current) {
                  composing.current = false;
                  sendText(event.data);
                  event.currentTarget.value = "";
                }
              }}
              onInput={(event) => {
                const input = event.nativeEvent as InputEvent;
                if (!composing.current && !input.isComposing) {
                  sendText(event.currentTarget.value);
                  event.currentTarget.value = "";
                }
              }}
              onBlur={(event) => {
                composing.current = false;
                event.currentTarget.value = "";
              }}
            />
          </div>
        </>
      ) : (
        <div
          className="grid aspect-[25/16] place-content-center justify-items-center gap-2 rounded-xl border border-border-default bg-surface-hover text-ink-muted"
          role="status"
        >
          <Monitor size={22} /> Connecting desktop…
        </div>
      )}
    </div>
  );
};
