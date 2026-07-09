import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../../lib/markdownComponents";

// Stable across renders: the component map has no per-render inputs and the
// plugin list never changes, so build both once at module load.
const COMPONENTS = markdownComponents();
const REMARK_PLUGINS = [remarkGfm];

/** Rendered Markdown pane for REVIEW's editor split. Renders the live editor
 *  buffer (`source`) with GFM. No rehype-raw: embedded HTML stays inert text. */
export function MarkdownPreview({ source }: { source: string }) {
  const rendered = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    ),
    [source],
  );

  return (
    <div
      data-testid="markdown-preview"
      className="octo-fade-in h-full overflow-auto px-6 py-5"
      style={{ background: "var(--color-octo-onyx)" }}
    >
      <div className="mx-auto max-w-[72ch]">{rendered}</div>
    </div>
  );
}
