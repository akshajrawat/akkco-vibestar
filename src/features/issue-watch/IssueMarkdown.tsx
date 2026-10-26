import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage } from "../../lib/api";

export const IssueMarkdown = ({
  text,
  onError,
}: {
  text: string;
  onError: (message: string) => void;
}) => (
  <div className="markdown issue-markdown">
    <Markdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ alt }) => <span className="subtle">[Image omitted{alt ? `: ${alt}` : ""}]</span>,
        a: ({ href, children }) => {
          let allowed = false;
          try {
            const url = new URL(href || "");
            allowed =
              url.protocol === "https:" &&
              url.hostname === "github.com" &&
              !url.port &&
              !url.username &&
              !url.password;
          } catch {
            /* Relative and external links remain visible as unverified text. */
          }
          return allowed ? (
            <a
              href={href}
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void window.vibestar
                  .openExternal(href!)
                  .catch((error) => onError(errorMessage(error)));
              }}
            >
              {children}
            </a>
          ) : (
            <span title={href}>
              {children} <small className="subtle">(unverified link)</small>
            </span>
          );
        },
      }}
    >
      {text || "No description provided."}
    </Markdown>
  </div>
);
