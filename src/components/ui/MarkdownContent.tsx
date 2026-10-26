import { isValidElement, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { highlightCode } from "../../lib/diff/highlight";
import { Button } from "./button";

const CodeBlock = ({ children }: ComponentProps<"pre">) => {
  const codeElement = isValidElement<{
    children?: ReactNode;
    className?: string;
  }>(children)
    ? children
    : undefined;
  const code = typeof codeElement?.props.children === "string" ? codeElement.props.children : "";
  const language = codeElement?.props.className?.match(/language-([\w+-]+)/)?.[1] || "text";
  const extension =
    new Map([
      ["javascript", "js"],
      ["typescript", "ts"],
      ["python", "py"],
      ["shell", "sh"],
    ]).get(language) || language;
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    if (feedback !== "Copied") return;
    const timer = setTimeout(() => setFeedback(""), 1600);
    return () => clearTimeout(timer);
  }, [feedback]);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={feedback === "Copied" ? "Code copied" : "Copy code"}
          disabled={!code}
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => setFeedback("Copied"))
              .catch(() => setFeedback("Copy unavailable"));
          }}
        >
          {feedback === "Copied" ? <Check size={12} /> : <Copy size={12} />}
          {feedback || "Copy"}
        </Button>
      </div>
      <pre>
        <code>
          {code && code.length <= 24000
            ? code.split("\n").map((line, index, lines) => (
                <span key={index}>
                  {highlightCode(line, `snippet.${extension}`).map((token, part) => (
                    <span key={part} className={`syntax-${token.kind}`}>
                      {token.text}
                    </span>
                  ))}
                  {index < lines.length - 1 ? "\n" : ""}
                </span>
              ))
            : code || children}
        </code>
      </pre>
      {feedback === "Copy unavailable" && <small role="status">Copy unavailable</small>}
    </div>
  );
};

export const MarkdownContent = ({ text }: { text: string }) => (
  <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
    {text}
  </Markdown>
);
