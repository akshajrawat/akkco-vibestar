import { useEffect, useRef } from "react";

import { useTaskView, updateTaskView } from "../../lib/taskView";

export const ChatSurface = ({
  id,
  activity,
  conversation,
  actions,
  composer,
  revision,
}: {
  id: string;
  activity: React.ReactNode;
  conversation: React.ReactNode;
  actions?: React.ReactNode;
  composer: React.ReactNode;
  revision: string | number;
}) => {
  const view = useTaskView(id);
  const scroll = useRef<HTMLDivElement>(null);
  const position = useRef({ top: view.chatScroll, follow: view.chatFollow });

  useEffect(() => {
    if (scroll.current && !view.expandedTool)
      scroll.current.scrollTop = position.current.follow
        ? scroll.current.scrollHeight
        : position.current.top;
  }, [revision, view.expandedTool]);

  return (
    <div className="chat-main" hidden={view.expandedTool}>
      {activity}
      <div
        className="event-timeline"
        ref={scroll}
        aria-label="Conversation"
        onScroll={(e) => {
          if (view.expandedTool) return;
          const el = e.currentTarget;

          position.current = {
            top: el.scrollTop,
            follow: el.scrollHeight - el.scrollTop - el.clientHeight < 80,
          };

          updateTaskView(id, {
            chatScroll: position.current.top,
            chatFollow: position.current.follow,
          });
        }}
      >
        {conversation}
      </div>
      <div className="chat-actions">{actions}</div>
      {composer}
    </div>
  );
};
