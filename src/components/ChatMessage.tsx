import { AUTO_MODEL } from "../lib/policy";
import ReactMarkdown from "react-markdown";
import { parseKeyPhrase } from "../lib/parseKeyPhrase";
import { ChatMarkdown, REMARK_PLUGINS } from "./chat/ChatMarkdown";

interface MessageProps {
  role: "user" | "assistant" | "tool" | "error" | string;
  content: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  contextTokens?: number | null;
  costUsd?: number | null;
}

/** The footer of an answer: `211k in · 94% cached · 2.1k out · $0.42`. The
 *  "in" figure is the LAST prompt's full size when the turn reported it
 *  (uncached + cached + written — the honest context figure), else the
 *  uncached total the old rows carry; the cached share is over every round
 *  of the turn. Pure so the wording is tested. */
export function usageFooter(m: MessageProps): string {
  const parts: string[] = [];
  const inTok = m.contextTokens ?? m.inputTokens;
  if (inTok != null) parts.push(`${formatTokenCount(inTok)} in`);
  const read = m.cacheReadTokens ?? 0;
  const uncached = m.inputTokens ?? 0;
  const written = m.cacheCreationTokens ?? 0;
  const prompt = uncached + read + written;
  if (read > 0 && prompt > 0) parts.push(`${Math.round((read / prompt) * 100)}% cached`);
  if (m.outputTokens != null) parts.push(`${formatTokenCount(m.outputTokens)} out`);
  if (m.costUsd != null && m.costUsd > 0) parts.push(`$${m.costUsd < 0.01 ? m.costUsd.toFixed(3) : m.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

interface Props {
  message: MessageProps;
  /** When supplied, file-path-shaped inline code becomes a clickable link
   *  that opens the file in the in-app editor. */
  onOpenInEditor?: (path: string) => void;
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

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function modelDisplayName(model: string | null | undefined): string {
  // The streaming bubble carries the store's model until the persisted row
  // arrives with the resolved id; under Auto that is the policy's name.
  if (model === AUTO_MODEL) return "Auto";
  if (!model) return "Assistant";
  return MODEL_DISPLAY[model] ?? model;
}

export function ChatMessage({ message, onOpenInEditor }: Props) {
  const { role, content, model, inputTokens, outputTokens } = message;

  if (!content || !content.trim()) return null;

  // A cancelled turn — a quiet, centered system note, never a model bubble.
  if (role === "stopped") {
    return (
      <div
        data-role="stopped"
        className="flex items-center justify-center gap-2 py-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute"
      >
        <span aria-hidden>◼</span>
        {content}
      </div>
    );
  }

  if (role === "user") {
    // Shown exactly as written: `whitespace-pre-wrap` keeps the line breaks,
    // indentation and typed bullets the Composer let the user enter (⇧↵),
    // and `break-words` wraps an unbroken token (a digest, a long URL) instead
    // of overflowing. Deliberately NOT Markdown — a pasted log, stack trace or
    // snippet must not lose its `#`, `*`, `<tags>` or indented lines.
    return (
      <div data-role="user" className="octo-selectable flex flex-col gap-1.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          — You
        </div>
        <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.55] text-octo-ivory">
          {content}
        </div>
      </div>
    );
  }

  // Assistant: parse key phrase + body, render eyebrow + lead + markdown body.
  const { keyPhrase, body } = parseKeyPhrase(content);

  return (
    <div data-role="assistant" className="octo-selectable flex flex-col gap-2">
      <div className="animate-keyfade-eyebrow font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        — {modelDisplayName(model)}
      </div>

      {keyPhrase && (
        <div className="animate-keyfade-key">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
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
                  <p className="font-serif text-[20px] leading-[1.15] tracking-[-0.005em] text-octo-ivory">
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
          <ChatMarkdown text={body} onOpenInEditor={onOpenInEditor} />
        </div>
      )}

      {(inputTokens != null || outputTokens != null) && (
        <div
          className="animate-keyfade-body font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute"
          title="Last prompt size · share of it served from the prompt cache · answer tokens · this turn's cost"
        >
          {usageFooter(message)}
        </div>
      )}
    </div>
  );
}
