import { useId, useLayoutEffect, useRef, useState } from "react";

/** Keep large workflow briefs readable without burying the response below them. */
export const UserMessageBody = ({ children }: { children: React.ReactNode }) => {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [children, expanded]);

  return (
    <>
      <div
        id={id}
        ref={body}
        className={`user-message-body${expanded ? " expanded" : ""}${overflow && !expanded ? " clipped" : ""}`}
      >
        {children}
      </div>
      {overflow && (
        <button
          className="message-expand"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
};
