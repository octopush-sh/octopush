// The one Markdown renderer for model prose in Talk — the assistant body,
// a sub-agent's report (crew card + Companion journal), anything the model
// wrote for a human to read. GitHub-flavored Markdown is ON: models write
// tables, task lists and strikethrough as a matter of course, and without
// `remark-gfm` a table collapses into one run-on paragraph. Tool OUTPUT is
// not prose and keeps its mono <pre> in the tool cards.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { clsx } from "clsx";
import type { Components } from "react-markdown";

/** Shared plugin list — a stable reference so react-markdown never re-parses
 *  because the array identity changed. */
export const REMARK_PLUGINS = [remarkGfm];

// Detects file-path-shaped strings inside inline code. We deliberately keep
// the heuristic conservative — only strings that contain a slash OR end in
// a short extension qualify. Excludes URLs (anything with `://`).
export function looksLikeFilePath(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed || trimmed.includes("://") || trimmed.includes(" ")) return false;
  if (trimmed.length > 200) return false;
  if (trimmed.includes("/")) return true;
  // Filename with extension (e.g. App.tsx, config.json, README.md)
  return /^[\w.\-]+\.[A-Za-z0-9]{1,8}$/.test(trimmed);
}

// Markdown renderers using Onyx & Brass design tokens. Body text only —
// ChatMessage renders the lead sentence (key phrase) separately as upright
// serif. Chat-tuned (h3 is a brass eyebrow); REVIEW's document-grade map
// lives in lib/markdownComponents.tsx.
export function makeMarkdownComponents(
  onOpenInEditor?: (path: string) => void,
): Components {
  return {
  code({ className, children, ...rest }) {
    const isInline = !className;
    if (isInline) {
      const text = String(children ?? "").trim();
      if (onOpenInEditor && looksLikeFilePath(text)) {
        return (
          <button
            type="button"
            onClick={() => onOpenInEditor(text)}
            className="rounded-[3px] px-1.5 py-0.5 font-mono text-[12px] text-octo-brass transition-colors hover:bg-octo-brass/20"
            style={{ background: "var(--brass-ghost)" }}
            title="Open in editor"
          >
            {children}
          </button>
        );
      }
      return (
        <code
          className="rounded-[3px] px-1.5 py-0.5 font-mono text-[12px] text-octo-brass"
          style={{ background: "var(--brass-ghost)" }}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className={clsx(
          "block overflow-x-auto rounded-md border border-octo-hairline bg-octo-onyx p-4 font-mono text-[12px] leading-relaxed text-octo-sage",
          className,
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <pre className="my-3 overflow-x-auto rounded-md">{children}</pre>;
  },
  p({ children }) {
    return <p className="mb-3 leading-[1.6] last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return (
      <ul className="mb-3 ml-1 list-inside list-disc space-y-1.5 leading-[1.55] last:mb-0 marker:text-octo-mute">
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="mb-3 ml-1 list-inside list-decimal space-y-1.5 leading-[1.55] last:mb-0 marker:text-octo-brass">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li className="leading-[1.55]">{children}</li>;
  },
  // GFM task list — a read-only brass checkbox; the surrounding <li> keeps
  // its marker hidden by react-markdown's `task-list-item` class.
  input({ checked, type }) {
    return type === "checkbox" ? (
      <input
        type="checkbox"
        checked={!!checked}
        readOnly
        className="mr-1.5 accent-[var(--color-octo-brass)] align-middle"
      />
    ) : null;
  },
  h1({ children }) {
    return (
      <h1 className="mb-3 mt-4 font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mb-2 mt-4 font-serif text-[16px] text-octo-ivory first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mb-1.5 mt-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass first:mt-0">
        {children}
      </h3>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote
        className="my-3 py-1 pl-3 text-octo-sage"
        style={{ borderLeft: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }}
      >
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-4 h-px border-0 bg-octo-hairline" />;
  },
  strong({ children }) {
    return <strong className="font-semibold text-octo-ivory">{children}</strong>;
  },
  em({ children }) {
    return <em className="not-italic font-medium text-octo-ivory">{children}</em>;
  },
  // GFM strikethrough — mute, not rouge: it is a retraction, not an error.
  del({ children }) {
    return <del className="text-octo-mute line-through decoration-octo-mute/60">{children}</del>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        className="text-octo-brass underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
        target="_blank"
        rel="noopener"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-3 max-h-[420px] overflow-auto rounded-md border border-octo-hairline">
        <table className="w-full text-[12px]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="sticky top-0 z-[1] border-b border-octo-hairline bg-octo-panel px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border-b border-octo-hairline px-3 py-2 text-octo-sage">
        {children}
      </td>
    );
  },
  };
}

interface Props {
  text: string;
  onOpenInEditor?: (path: string) => void;
}

/** Model prose → Onyx & Brass Markdown, GFM included. */
export function ChatMarkdown({ text, onOpenInEditor }: Props) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={makeMarkdownComponents(onOpenInEditor)}>
      {text}
    </ReactMarkdown>
  );
}
