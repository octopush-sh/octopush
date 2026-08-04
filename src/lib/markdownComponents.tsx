import { clsx } from "clsx";
import type { Components } from "react-markdown";

/** Structural shape of the hast node react-markdown hands each renderer. Kept
 *  local (rather than importing hast types) because only the position matters. */
type PositionedNode = { position?: { start?: { line?: number } } } | undefined;

/** Stamp the 1-based source line a block came from as `data-md-line`, so the
 *  rendered pane can point back at the buffer that produced it (REVIEW's
 *  Markdown jump-to-source). Inert everywhere else. A node whose position the
 *  parser dropped simply isn't a jump target. */
function lineAttr(node: PositionedNode): { "data-md-line"?: number } {
  const line = node?.position?.start?.line;
  return typeof line === "number" ? { "data-md-line": line } : {};
}

/** Document-grade renderers for the REVIEW Markdown preview, styled with
 *  Onyx & Brass tokens. Separate from ChatMessage's chat-tuned map (which
 *  renders h3 as a brass eyebrow; both maps render hr as a solid hairline —
 *  the brass gradient rule is retired). */
export function markdownComponents(): Components {
  return {
    h1: ({ children, node }) => (
      <h1 {...lineAttr(node)} className="mb-3 mt-5 font-serif text-[22px] leading-tight tracking-[-0.01em] text-octo-ivory first:mt-0">{children}</h1>
    ),
    h2: ({ children, node }) => (
      <h2 {...lineAttr(node)} className="mb-2 mt-5 font-serif text-[18px] leading-tight text-octo-ivory first:mt-0">{children}</h2>
    ),
    h3: ({ children, node }) => (
      <h3 {...lineAttr(node)} className="mb-2 mt-4 font-serif text-[15px] text-octo-ivory first:mt-0">{children}</h3>
    ),
    h4: ({ children, node }) => (
      <h4 {...lineAttr(node)} className="mb-1.5 mt-4 font-serif text-[13px] text-octo-ivory first:mt-0">{children}</h4>
    ),
    h5: ({ children, node }) => (
      <h5 {...lineAttr(node)} className="mb-1.5 mt-3 font-mono text-[10px] uppercase tracking-[0.22em] text-octo-brass first:mt-0">{children}</h5>
    ),
    h6: ({ children, node }) => (
      <h6 {...lineAttr(node)} className="mb-1.5 mt-3 font-mono text-[9px] uppercase tracking-[0.22em] text-octo-mute first:mt-0">{children}</h6>
    ),
    p: ({ children, node }) => (
      <p {...lineAttr(node)} className="mb-3 font-sans text-[13px] leading-[1.6] text-octo-sage last:mb-0">{children}</p>
    ),
    strong: ({ children }) => <strong className="font-semibold text-octo-ivory">{children}</strong>,
    em: ({ children }) => <em className="font-medium text-octo-ivory">{children}</em>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer"
         className="text-octo-brass underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass">
        {children}
      </a>
    ),
    ul: ({ children, node }) => (
      <ul {...lineAttr(node)} className="mb-3 ml-5 list-disc space-y-1 text-[13px] leading-[1.6] text-octo-sage marker:text-octo-brass last:mb-0">{children}</ul>
    ),
    ol: ({ children, node }) => (
      <ol {...lineAttr(node)} className="mb-3 ml-5 list-decimal space-y-1 text-[13px] leading-[1.6] text-octo-sage marker:text-octo-mute last:mb-0">{children}</ol>
    ),
    li: ({ children, node }) => <li {...lineAttr(node)} className="leading-[1.6]">{children}</li>,
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <input type="checkbox" checked={!!checked} readOnly
               className="mr-1.5 accent-[var(--color-octo-brass)] align-middle" />
      ) : null,
    blockquote: ({ children, node }) => (
      <blockquote {...lineAttr(node)} className="my-3 py-1 pl-3 text-octo-sage"
                  style={{ borderLeft: "2px solid var(--brass-dim)" }}>
        {children}
      </blockquote>
    ),
    hr: ({ node }) => <hr {...lineAttr(node)} className="my-5 h-px border-0 bg-octo-hairline" />,
    // `node` is destructured out on purpose: it is react-markdown's own prop,
    // not a DOM attribute, and spreading it onto <code> makes React warn. The
    // <pre> wrapper already carries the jump line for a fenced block.
    code: ({ className, children, node: _node, ...domProps }) => {
      // react-markdown v10 no longer passes an `inline` prop. A fenced/indented
      // block is wrapped in <pre> and carries a `language-*` class only when a
      // language is named — so `!className` alone mis-styles an UNLABELED ```
      // fence (common in docs) as an inline pill. Treat anything with a language
      // class OR a newline (i.e. multi-line block content) as a block.
      const isBlock = className != null || String(children ?? "").includes("\n");
      if (!isBlock) {
        return (
          <code className="rounded-[3px] px-1.5 py-0.5 font-mono text-[12px] text-octo-brass"
                style={{ background: "var(--brass-ghost)" }} {...domProps}>
            {children}
          </code>
        );
      }
      return (
        <code className={clsx("block overflow-x-auto rounded-md border border-octo-hairline bg-octo-onyx p-3 font-mono text-[12px] leading-relaxed text-octo-sage", className)} {...domProps}>
          {children}
        </code>
      );
    },
    pre: ({ children, node }) => <pre {...lineAttr(node)} className="my-3 overflow-x-auto rounded-md">{children}</pre>,
    table: ({ children, node }) => (
      // The jump line lives on the wrapper, not on <table>: an overflow-x box
      // would clip a marker rendered against its left edge.
      <div {...lineAttr(node)} className="my-3 overflow-x-auto rounded-md border border-octo-hairline">
        <table className="w-full text-[12px]">{children}</table>
      </div>
    ),
    tr: ({ children, node }) => <tr {...lineAttr(node)}>{children}</tr>,
    th: ({ children }) => (
      <th className="border-b border-octo-hairline bg-octo-panel px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border-b border-octo-hairline px-3 py-2 text-octo-sage">{children}</td>
    ),
    img: ({ src, alt, node }) => (
      <img {...lineAttr(node)} src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-3 max-w-full rounded-md" />
    ),
  };
}
