import ReactMarkdown from "react-markdown";
import { parseKeyPhrase } from "../lib/parseKeyPhrase";
import { ChatMarkdown, REMARK_PLUGINS } from "./chat/ChatMarkdown";

interface MessageProps {
  role: "user" | "assistant" | "tool" | "error" | string;
  content: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
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
    return (
      <div data-role="user" className="octo-selectable flex flex-col gap-1.5">
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
