import { createContext, useContext } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Opens a link from rendered markdown outside the app, in the default
 * browser. The app's window is the app itself: following a link in it would
 * replace the whole app with the page.
 */
export const OpenLinkContext = createContext<(url: string) => void>(
  () => undefined,
);

export function MarkdownPreview({ source }: { source: string }) {
  const openLink = useContext(OpenLinkContext);
  if (!source.trim())
    return (
      <div className="brief-placeholder">
        <strong>No task brief yet</strong>
        <span>Add goals, context, and acceptance criteria for the agent.</span>
      </div>
    );
  return (
    <div className="markdown-body">
      <Markdown
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) openLink(href);
              }}
            >
              {children}
            </a>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {source}
      </Markdown>
    </div>
  );
}
