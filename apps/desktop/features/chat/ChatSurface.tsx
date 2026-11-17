import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";

import { useTaskView, updateTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";

interface ChatSurfaceProps {
  id: string;
  activity: React.ReactNode;
  conversation: React.ReactNode;
  actions?: React.ReactNode;
  composer: React.ReactNode;
  revision: string | number;
  empty?: boolean;
}

export const ChatSurface = (props: ChatSurfaceProps) => (
  <ConversationSurface key={props.id} {...props} />
);

/** Resize-driven following stays local; scrolling history must never rebuild the workspace. */
const ConversationSurface = ({
  id,
  activity,
  conversation,
  actions,
  composer,
  revision,
  empty = false,
}: ChatSurfaceProps) => {
  const view = useTaskView(id);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composerLane = useRef<HTMLDivElement>(null);
  const previousLayout = useRef<{ empty: boolean; rect: DOMRect }>(null);
  const position = useRef({ top: view.chatScroll, follow: view.chatFollow });
  const [away, setAway] = useState(!view.chatFollow);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const alignOutput = useCallback(() => {
    const element = scroll.current;
    if (!element || element.closest("[hidden]")) return;
    if (position.current.follow) element.scrollTop = element.scrollHeight;
    position.current.top = element.scrollTop;
  }, []);

  const persistPosition = () => {
    clearTimeout(persistTimer.current);

    persistTimer.current = setTimeout(() => {
      updateTaskView(id, { chatScroll: position.current.top, chatFollow: position.current.follow });
    }, 150);
  };

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element || view.expandedTool) return;
    if (position.current.follow) alignOutput();
    else element.scrollTop = position.current.top;
    setAway(!position.current.follow);
  }, [revision, view.expandedTool, alignOutput]);

  useLayoutEffect(() => {
    position.current.follow = view.chatFollow;
    if (view.chatFollow) alignOutput();
    setAway(!view.chatFollow);
  }, [view.chatFollow, alignOutput]);

  useLayoutEffect(() => {
    const element = scroll.current;
    const body = content.current;
    if (!element || !body) return;
    let frame = 0;

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame);

            frame = requestAnimationFrame(() => {
              const composerBounds = composerLane.current?.getBoundingClientRect();

              element.parentElement?.style.setProperty(
                "--composer-height",
                `${composerBounds?.height || 0}px`,
              );

              if (
                previousLayout.current?.empty &&
                element.parentElement?.classList.contains("chat-draft") &&
                composerBounds
              )
                previousLayout.current = { empty: true, rect: composerBounds };

              if (position.current.follow && !element.closest("[hidden]")) {
                alignOutput();
              }
            });
          });

    observer?.observe(body);
    observer?.observe(element);
    if (composerLane.current) observer?.observe(composerLane.current);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(persistTimer.current);
      updateTaskView(id, { chatScroll: position.current.top, chatFollow: position.current.follow });
    };
  }, [id, alignOutput]);

  // Keep the composer transition from the empty workspace responsive to reduced motion.
  useLayoutEffect(() => {
    const lane = composerLane.current;
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    const previous = previousLayout.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let animation: Animation | undefined;
    if (
      previous &&
      previous.empty !== empty &&
      Math.abs(previous.rect.top - rect.top) >= 0.5 &&
      !reduced &&
      lane.animate
    ) {
      animation = lane.animate(
        [
          { transform: `translateY(${previous.rect.top - rect.top}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 300, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
      );
    }

    previousLayout.current = { empty, rect };
    return () => animation?.cancel();
  }, [empty]);

  return (
    <div className={`chat-main ${empty ? "chat-draft" : ""}`} hidden={view.expandedTool}>
      {activity}
      <div
        className="event-timeline"
        ref={scroll}
        tabIndex={0}
        aria-label="Conversation"
        onScroll={(event) => {
          if (view.expandedTool) return;
          const element = event.currentTarget;
          const follow = element.scrollHeight - element.scrollTop - element.clientHeight <= 32;

          position.current = { top: element.scrollTop, follow };
          setAway((current) => (current === !follow ? current : !follow));
          persistPosition();
        }}
      >
        <div className="timeline-content" ref={content}>
          {conversation}
        </div>
      </div>
      {away && !empty && (
        <Button
          className="scroll-to-latest"
          size="icon"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={() => {
            const element = scroll.current;
            if (!element) return;
            position.current.follow = true;
            element.scrollTop = element.scrollHeight;
            position.current.top = element.scrollTop;
            setAway(false);
            persistPosition();
          }}
        >
          <ArrowDown size={19} />
        </Button>
      )}
      <div className="chat-actions">
        <div className="chat-actions-content">{actions}</div>
      </div>
      <div className="composer-lane" ref={composerLane}>
        {composer}
      </div>
    </div>
  );
};
