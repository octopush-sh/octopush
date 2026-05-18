import ReactMarkdown from "react-markdown";
import { clsx } from "clsx";
import type { Components } from "react-markdown";
import { parseKeyPhrase } from "../lib/parseKeyPhrase";

interface MessageProps {
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface Props {
  message: MessageProps;
}

// Maps Anthropic / OpenAI model IDs to short display names. Falls back to
// the raw ID when not in the table.
const MODEL_DISPLAY: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "claude-haiku-4-5": "Haiku 4.5",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o mini",
};

// Markdown renderers using Onyx & Brass design tokens. Body text only —
// the lead sentence (key phrase) is rendered separately above as italic serif.
const markdownComponents: Components = {
  code({ className, children, ...rest }) {
    const isInline = !className;
    if (isInline) {
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
  h1({ children }) {
    return (
      <h1 className="mb-3 mt-4 font-serif italic text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mb-2 mt-4 font-serif italic text-[16px] text-octo-ivory first:mt-0">
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
    return (
      <hr
        className="my-4 h-px border-0"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
    );
  },
  strong({ children }) {
    return <strong className="font-semibold text-octo-ivory">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic text-octo-ivory">{children}</em>;
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
      <div className="my-3 overflow-x-auto rounded-md border border-octo-hairline">
        <table className="w-full text-[12px]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border-b border-octo-hairline bg-octo-panel px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
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

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function modelDisplayName(model: string | null | undefined): string {
  if (!model) return "Assistant";
  return MODEL_DISPLAY[model] ?? model;
}

export function ChatMessage({ message }: Props) {
  const { role, content, model, inputTokens, outputTokens } = message;

  if (!content || !content.trim()) return null;

  if (role === "user") {
    return (
      <div data-role="user" className="chat-selectable flex flex-col gap-1.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          — You
        </div>
        <div className="text-[14px] leading-[1.55] text-octo-ivory">
          {content}
        </div>
      </div>
    );
  }

  // Assistant: parse key phrase + body, render eyebrow + lead + markdown body.
  const { keyPhrase, body } = parseKeyPhrase(content);

  return (
    <div data-role="assistant" className="chat-selectable flex flex-col gap-2">
      <div className="animate-keyfade-eyebrow font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        — {modelDisplayName(model)}
      </div>

      {keyPhrase && (
        <div className="animate-keyfade-key">
          <ReactMarkdown
            components={{
              code({ children }) {
                return (
                  <code className="font-mono not-italic text-octo-brass">
                    {children}
                  </code>
                );
              },
              p({ children }) {
                return (
                  <p className="font-serif italic text-[20px] leading-[1.15] tracking-[-0.005em] text-octo-ivory">
                    {children}
                  </p>
                );
              },
            }}
          >
            {keyPhrase}
          </ReactMarkdown>
        </div>
      )}

      {body && (
        <div className="animate-keyfade-body text-[13px] leading-[1.6] text-octo-sage">
          <ReactMarkdown components={markdownComponents}>{body}</ReactMarkdown>
        </div>
      )}

      {(model || inputTokens != null || outputTokens != null) && (
        <div className="animate-keyfade-body font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
          {[
            inputTokens != null ? `${formatTokenCount(inputTokens)} in` : null,
            outputTokens != null ? `${formatTokenCount(outputTokens)} out` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}
