import { ChevronRight } from "lucide-react";
import { HunkRail } from "./HunkRail";
import { DiffLines } from "./DiffLines";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";
import type { DiffFile } from "../../lib/diffParser";

interface Props {
  file: DiffFile;
  focusedHunk: number;
  viewed: boolean;
  collapsed: boolean;
  onAccept: (hunkIdx: number) => void;
  onReject: (hunkIdx: number) => void;
  onWhy: (hunkIdx: number) => void;
  onToggleViewed: () => void;
  onToggleCollapsed: () => void;
}

export function FileDiffSection({
  file,
  focusedHunk,
  viewed,
  collapsed,
  onAccept,
  onReject,
  onWhy,
  onToggleViewed,
  onToggleCollapsed,
}: Props) {
  const mode = useReviewPrefs((s) => s.readingMode);

  const typeLabel =
    file.changeType === "new"
      ? "NEW"
      : file.changeType === "deleted"
        ? "DELETED"
        : "MODIFIED";

  const typeColor =
    file.changeType === "new"
      ? "text-octo-verdigris"
      : file.changeType === "deleted"
        ? "text-octo-rouge"
        : "text-octo-brass";

  const id = `review-file-${encodeURIComponent(file.filePath)}`;

  return (
    <div className="scroll-mt-4" id={id}>
      {/* ── File header row ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-octo-hairline pb-1.5">
        <span
          className={`font-mono text-[9px] font-semibold uppercase tracking-[0.2em] ${typeColor}`}
        >
          {typeLabel}
        </span>
        <span className="text-octo-hairline">·</span>
        <span className="font-mono text-[12.5px] text-octo-ivory">
          {file.filePath}
        </span>
        <button
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          className="text-octo-mute transition-colors hover:text-octo-sage focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <ChevronRight
            size={11}
            className={collapsed ? "" : "rotate-90"}
            style={{
              transition: "transform var(--dur-quick) var(--ease-octo)",
            }}
          />
        </button>
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
          {file.hunks.length} hunk{file.hunks.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={onToggleViewed}
          className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] focus-visible:ring-1 focus-visible:ring-octo-brass ${
            viewed
              ? "text-octo-verdigris"
              : "text-octo-mute hover:text-octo-sage"
          }`}
        >
          {viewed ? "✓ viewed" : "mark viewed"}
        </button>
      </div>

      {/* ── Collapsible content — grid-rows 0fr↔1fr idiom ──────────── */}
      <div
        data-collapsed={collapsed}
        className="grid transition-[grid-template-rows] duration-[var(--dur-standard)]"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          {file.hunks.map((hunk, i) => (
            <div key={i} className="mt-3">
              {/* staged is always false here: the Review diff source is the
                  index→workdir (unstaged) diff, so an accepted hunk leaves this
                  view on refetch rather than dimming in place. Per-hunk staged
                  dimming needs the staged diff too — that's part of G4's staging
                  model. HunkRail keeps the `staged` prop as the ready hook. */}
              <HunkRail
                range={fmtRange(hunk.header)}
                additions={hunk.additions}
                deletions={hunk.deletions}
                focused={focusedHunk === i}
                staged={false}
                onAccept={() => onAccept(i)}
                onReject={() => onReject(i)}
                onWhy={() => onWhy(i)}
              />
              <DiffLines rows={hunk.rows} filePath={file.filePath} mode={mode} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Convert a raw @@ header into a human-readable line range string. */
function fmtRange(header: string): string {
  const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return header;
  const oEnd = parseInt(m[1], 10) + (parseInt(m[2] || "1", 10) - 1);
  const nEnd = parseInt(m[3], 10) + (parseInt(m[4] || "1", 10) - 1);
  return `lines ${m[1]}–${oEnd} → ${m[3]}–${nEnd}`;
}
