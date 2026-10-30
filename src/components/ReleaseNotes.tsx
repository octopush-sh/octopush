// Release notes (the updater manifest's `notes` Markdown), rendered safely.
//
// The manifest comes from the network, so: raw HTML is dropped (`skipHtml`,
// no rehype-raw), images are never fetched (alt text only), unsafe URL
// schemes are stripped by react-markdown's default `urlTransform`, and links
// open in the user's browser via the system opener — only http(s) and mailto.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../lib/markdownComponents";
import { ipc } from "../lib/ipc";

/** True for a link the notes may open in the browser. */
export function isSafeNotesHref(href: string | undefined | null): href is string {
  return typeof href === "string" && /^(https?:|mailto:)/i.test(href.trim());
}

const BASE = markdownComponents();

const COMPONENTS: Components = {
  ...BASE,
  a: ({ href, children }) =>
    isSafeNotesHref(href) ? (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          void ipc.openFileInSystem(href).catch(() => {});
        }}
        className="text-octo-brass underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Never load an image from the notes (tracking pixels, remote content).
  img: ({ alt }) => (alt ? <span className="text-octo-mute">{alt}</span> : null),
};

export function ReleaseNotes({ markdown, className = "" }: { markdown: string; className?: string }) {
  return (
    <div className={`release-notes ${className}`} data-testid="release-notes">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={COMPONENTS}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
