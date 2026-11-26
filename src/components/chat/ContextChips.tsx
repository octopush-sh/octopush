import { FileText, Folder, GitCompare, SquareTerminal, X } from "lucide-react";
import { formatTokenCount } from "../../lib/cost";
import { tourId } from "../../lib/tour/ids";
import { MAX_MENTIONS, chipLabel, quoteToken, type ContextRef } from "../../lib/talkContext";

interface Props {
  refs: ContextRef[];
  /** Estimated tokens per ref token, once its block is resolved. */
  tokensByToken: Record<string, number>;
  onRemove: (token: string) => void;
  /** Mentions past MAX_MENTIONS, sent as plain text. */
  over?: number;
}

const ICON = { file: FileText, folder: Folder, session: SquareTerminal, diff: GitCompare } as const;

const WHAT = {
  file: "File",
  folder: "Folder listing",
  session: "Run session output",
  diff: "Diff",
} as const;

/**
 * The context riding with this draft (#962): one chip per `@` token that
 * resolved — a file or line range, a folder listing, a Run session's output,
 * the diff — with its token estimate. The chips mirror the text: removing
 * one removes its token from the draft. Past MAX_MENTIONS (#1046) a quiet
 * line says how many go as plain text. Renders nothing when empty.
 */
export function ContextChips({ refs, tokensByToken, onRemove, over = 0 }: Props) {
  if (refs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3" aria-label="Context for this message">
      {refs.map((ref, i) => {
        const Icon = ICON[ref.kind];
        const tokens = tokensByToken[ref.token];
        return (
          <span
            key={ref.token}
            data-tour={i === 0 ? tourId("talk-context-chip") : undefined}
            title={`${WHAT[ref.kind]} · @${quoteToken(ref.token)}${tokens != null ? ` · ≈ ${formatTokenCount(tokens)} tokens` : ""}`}
            className="octo-pop-in flex items-center gap-1.5 rounded-md border border-octo-hairline bg-octo-panel py-0.5 pl-1.5 pr-1 font-mono text-[10px] text-octo-sage"
          >
            <Icon size={11} className="text-octo-mute" aria-hidden />
            <span className="max-w-[12rem] truncate">{chipLabel(ref)}</span>
            {tokens != null && (
              <span className="octo-tabular text-octo-mute">{formatTokenCount(tokens)}</span>
            )}
            <button
              type="button"
              onClick={() => onRemove(ref.token)}
              aria-label={`Remove @${ref.token}`}
              title="Remove from this message"
              className="flex items-center text-octo-mute transition-colors hover:text-octo-rouge"
            >
              <X size={11} />
            </button>
          </span>
        );
      })}
      {over > 0 && (
        <span
          data-tour="talk-context-cap"
          role="status"
          className="octo-fade-in font-mono text-[10px] text-octo-warning"
          title={`A message attaches at most ${MAX_MENTIONS} mentions; the rest are sent as plain text`}
        >
          {MAX_MENTIONS} at most · {over} more sent as text
        </span>
      )}
    </div>
  );
}
