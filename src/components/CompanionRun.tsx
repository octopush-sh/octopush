import { useRef } from "react";
import { GitCompare, Maximize2 } from "lucide-react";
import type { FileChange, GitStatus, SessionUsage } from "../lib/types";
import { useTerminalsStore } from "../stores/terminalsStore";
import { useReviewSource } from "../stores/reviewSourceStore";
import { useSessionUsage } from "../hooks/useSessionUsage";
import { useMissionLogbook } from "../hooks/useMissionLogbook";
import { fmtHours } from "../lib/logbook";
import { baseName, commitCount } from "../lib/reviewSource";
import {
  changesMeta,
  MAX_CHANGE_ROWS,
  NO_CHANGE_STATS,
  pathTail,
  STATUS_LETTER,
  STATUS_WORD,
  type ChangeStats,
} from "../lib/runChanges";
import { tourId } from "../lib/tour/ids";
import { CompanionSection } from "./CompanionSection";
import { ContextMeter, contextTone } from "./ContextMeter";
import { usd } from "./CompanionContext";
import { MidTruncate } from "./primitives/MidTruncate";
import { Reveal } from "./primitives/Reveal";

interface Props {
  workspaceId: string;
  /** The workspace's git status, from App's own poll (Review reads the same). */
  gitStatus: GitStatus | null;
  /** Lines added and removed per uncommitted file, from the working diff App
   *  reads while this panel is open in Run. */
  changeStats?: ChangeStats;
  /** Open Review at a file of the working diff. */
  onJumpToFile?: (file: string, line: number | null) => void;
  /** Switch to Review. */
  onReadDiff?: () => void;
  /** Open the Logbook Room. */
  onOpenLogbook?: () => void;
}

/**
 * Run mode's Companion: what the terminals can't show.
 *
 * Three sections on the Companion's one chrome (`CompanionSection`), top to
 * bottom: **Context** — how much room and money the focused pane's agent
 * session has used; **Changes** — what the sessions have changed in this
 * worktree, and the way into Review; **Mission** — the worked time and
 * spend of the mission this workspace serves. Nothing here repeats the
 * canvas: a session's name, state and controls live on its pane.
 *
 * A section with nothing to say is not drawn: Context folds away for a
 * shell, a dev server or a session Octopush has no usage for, and Mission
 * needs a mission.
 */
export function CompanionRun({
  workspaceId,
  gitStatus,
  changeStats = NO_CHANGE_STATS,
  onJumpToFile,
  onReadDiff,
  onOpenLogbook,
}: Props) {
  return (
    <div className="flex flex-col">
      <ContextSection workspaceId={workspaceId} />
      {/* Their own column, so Changes is its first child and draws no rule
          of its own: the one above it belongs to Context and folds with it. */}
      <div className="flex flex-col">
        <ChangesSection
          workspaceId={workspaceId}
          gitStatus={gitStatus}
          stats={changeStats}
          onJumpToFile={onJumpToFile}
          onReadDiff={onReadDiff}
        />
        <MissionSection workspaceId={workspaceId} onOpenLogbook={onOpenLogbook} />
      </div>
    </div>
  );
}

// ─── Context ──────────────────────────────────────────────────────

const LABEL = "pt-px text-[9px] uppercase tracking-[0.15em] text-octo-mute";
const ROWS = "m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[10px]";

/** The session's spend as the Spent row prints it. Every call unpriced: the
 *  cost is unknown, never `$0.00` (the rule Talk's cost line follows). */
export function spentLabel(usage: Pick<SessionUsage, "spentUsd" | "calls" | "unpricedCalls">): string {
  return usage.unpricedCalls > 0 && usage.unpricedCalls >= usage.calls ? "unpriced" : usd(usage.spentUsd);
}

function ContextSection({ workspaceId }: { workspaceId: string }) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const session = terminals.find((t) => t.id === activeId) ?? null;
  // Only an agent session has a context window and a ledger; a shell, a dev
  // server or a log tail is never asked about.
  const agent = !!session && session.role === "agent" && !session.failed;
  const usage = useSessionUsage(agent ? session.id : null);
  const open = agent && !!usage;

  // What the section last showed, kept while it folds away so the figures
  // leave with it instead of blanking first. Always a session's own pair:
  // its name with its numbers.
  const shown = useRef<{ label: string; usage: SessionUsage } | null>(null);
  if (open) shown.current = { label: session.label, usage };
  const view = shown.current;

  return (
    <Reveal open={open}>
      {view && (
        <CompanionSection
          title="Context"
          meta={view.label}
          hint={`What ${view.label} has used: its last prompt against the model's context window, and its cost`}
          storageKey="run-context"
          testId="companion-run-context"
          tourId={tourId("companion-run-context")}
          className="border-b"
        >
          <ContextBody usage={view.usage} />
        </CompanionSection>
      )}
    </Reveal>
  );
}

function ContextBody({ usage }: { usage: SessionUsage }) {
  const { contextTokens, maxContext } = usage;
  const { pct, tone } = contextTone(contextTokens ?? 0, maxContext ?? 0);
  const warn = contextTokens != null && maxContext != null && tone !== "ok";
  const unpriced = usage.unpricedCalls > 0;
  return (
    <div className="px-4 pb-3 pt-1">
      {contextTokens != null && (
        <div className="mb-2.5">
          <ContextMeter
            used={contextTokens}
            limit={maxContext}
            testId="run-context-meter"
            title={
              maxContext != null
                ? `The last prompt's size against the model's context window · ${Math.round(pct)}% used`
                : "The last prompt's size · this model's context window isn't in the catalog"
            }
          />
        </div>
      )}
      <dl className={ROWS}>
        <dt className={LABEL}>Spent</dt>
        <dd
          data-testid="run-context-spent"
          className="octo-tabular m-0 truncate text-octo-sage"
          title={
            unpriced
              ? `This session's cost in the ledger · ${usage.unpricedCalls} of ${usage.calls} model calls ran on a model with no price and are not in it`
              : `This session's cost in the ledger · ${usage.calls} model calls`
          }
        >
          {spentLabel(usage)}
        </dd>
        {usage.cacheHitPct != null && (
          <>
            <dt className={LABEL}>Cached</dt>
            <dd
              data-testid="run-context-cached"
              className="octo-tabular m-0 truncate text-octo-sage"
              title="The share of this session's prompt tokens served from the cache"
            >
              {Math.round(usage.cacheHitPct)}% of prompt tokens
            </dd>
          </>
        )}
        <dt className={LABEL}>Model</dt>
        <dd data-testid="run-context-model" className="m-0 truncate text-octo-sage" title={usage.model}>
          {usage.model}
        </dd>
      </dl>
      <Reveal open={warn}>
        <p data-testid="run-context-warning" className="m-0 pt-2 font-mono text-[10px] text-octo-warning">
          Past 80% · /compact soon
        </p>
      </Reveal>
    </div>
  );
}

// ─── Changes ──────────────────────────────────────────────────────

function ChangesSection({
  workspaceId,
  gitStatus,
  stats,
  onJumpToFile,
  onReadDiff,
}: {
  workspaceId: string;
  gitStatus: GitStatus | null;
  stats: ChangeStats;
  onJumpToFile?: (file: string, line: number | null) => void;
  onReadDiff?: () => void;
}) {
  // Commits since the base, from the committed view App reads for Review
  // and, while the tree is clean, for this line — no IPC of its own.
  const committed = useReviewSource((s) => s.committedByWs[workspaceId] ?? null);
  const files = gitStatus?.changedFiles ?? [];
  const clean = !!gitStatus && files.length === 0;
  const ahead = clean && committed && committed.commits > 0 ? committed : null;
  const rows = files.slice(0, MAX_CHANGE_ROWS);
  const more = files.length - rows.length;
  // Review has something to read: the working diff, or what was committed.
  const readable = files.length > 0 || !!ahead;

  return (
    <CompanionSection
      title="Changes"
      meta={changesMeta(files, stats)}
      hint="Uncommitted files in this workspace"
      storageKey="run-changes"
      testId="companion-run-changes"
      tourId={tourId("companion-run-changes")}
    >
      <div className="px-4 pb-3 pt-1">
        {files.length > 0 && (
          <ul className="-mx-1.5 flex list-none flex-col gap-px p-0">
            {rows.map((f) => (
              <ChangeRow key={f.path} file={f} stats={stats} onJump={onJumpToFile} />
            ))}
          </ul>
        )}
        {more > 0 && (
          <p data-testid="run-changes-more" className="octo-tabular m-0 pt-1 font-mono text-[10px] text-octo-mute">
            +{more} more
          </p>
        )}
        {/* A reserved line while the first status is on its way, so the
            section never claims a clean tree it hasn't seen. */}
        {files.length === 0 && (
          <p data-testid="run-changes-clean" className="m-0 min-h-4 text-[11px] text-octo-mute">
            {clean ? "The working tree is clean." : ""}
          </p>
        )}
        {ahead && (
          <div
            data-testid="run-changes-ahead"
            className="octo-fade-in mt-1.5 flex items-center gap-1.5 font-mono text-[11px] text-octo-sage"
            title={`Commits on this branch since ${baseName(ahead.base)}${ahead.mergeBase ? ` (merge base ${ahead.mergeBase})` : ""}`}
          >
            <GitCompare size={12} className="shrink-0 text-octo-mute" aria-hidden />
            <span className="octo-tabular">
              {commitCount(ahead.commits)} ahead of {baseName(ahead.base)}
            </span>
          </div>
        )}
        {readable && onReadDiff && (
          <button
            type="button"
            onClick={onReadDiff}
            data-tour="companion-run-read-diff"
            title="Open Review"
            className="mt-2.5 rounded font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            Read the diff
          </button>
        )}
      </div>
    </CompanionSection>
  );
}

function ChangeRow({
  file,
  stats,
  onJump,
}: {
  file: FileChange;
  stats: ChangeStats;
  onJump?: (file: string, line: number | null) => void;
}) {
  const stat = stats.byFile[file.path];
  const body = (
    <>
      <span
        className={`w-[10px] shrink-0 text-center ${file.status === "conflicted" ? "text-octo-rouge" : "text-octo-mute"}`}
        title={STATUS_WORD[file.status]}
      >
        {STATUS_LETTER[file.status]}
      </span>
      {/* A flex box with a definite width, so the path elides into the room
          the row leaves and its file name stays whole (design-system E1). */}
      <span className="flex min-w-0 flex-1">
        <MidTruncate text={file.path} tail={pathTail(file.path)} />
      </span>
      {stat && (stat.added > 0 || stat.removed > 0) && (
        <span className="octo-tabular flex shrink-0 gap-1.5">
          {stat.added > 0 && <span className="text-octo-verdigris">+{stat.added}</span>}
          {stat.removed > 0 && <span className="text-octo-rouge">−{stat.removed}</span>}
        </span>
      )}
    </>
  );
  const row = "octo-rise-in flex w-full items-center gap-2 rounded px-1.5 py-[3px] font-mono text-[11px] text-octo-sage";
  return (
    <li>
      {onJump ? (
        <button
          type="button"
          data-testid="run-change-row"
          onClick={() => onJump(file.path, null)}
          title={`${file.path} · open in Review`}
          className={`${row} text-left transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass`}
        >
          {body}
        </button>
      ) : (
        <div data-testid="run-change-row" className={row} title={file.path}>
          {body}
        </div>
      )}
    </li>
  );
}

// ─── Mission ──────────────────────────────────────────────────────

/** The mission this workspace serves: the Logbook line Talk's Conversation
 *  section and Direct's Logbook card show (`useMissionLogbook` — worked
 *  time, spend, savings over the mission's life), on the section chrome. */
function MissionSection({ workspaceId, onOpenLogbook }: { workspaceId: string; onOpenLogbook?: () => void }) {
  const { missionId, row, loaded } = useMissionLogbook(workspaceId);
  if (!missionId) return null;
  const hasWork = !!row && (row.hoursSecs > 0 || row.costUsd > 0);
  return (
    <CompanionSection
      title="Mission"
      hint="This mission's worked time and spend"
      storageKey="run-mission"
      testId="companion-run-mission"
      tourId={tourId("companion-run-mission")}
      action={
        onOpenLogbook ? (
          <button
            type="button"
            onClick={onOpenLogbook}
            title="Open the Logbook"
            aria-label="Open the Logbook"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <Maximize2 size={11} aria-hidden />
          </button>
        ) : undefined
      }
    >
      {/* A reserved first line, so the figures arriving never shift the panel. */}
      <div className="min-h-4 px-4 pb-3 pt-1">
        {hasWork ? (
          <dl className={`octo-fade-in ${ROWS}`}>
            <dt className={LABEL}>Worked</dt>
            <dd className="octo-tabular m-0 truncate text-octo-sage" title="Worked time (activity-span union)">
              {fmtHours(row!.hoursSecs)}
            </dd>
            <dt className={LABEL}>Spent</dt>
            <dd className="octo-tabular m-0 truncate text-octo-sage" title="Spend on this mission">
              {usd(row!.costUsd)}
            </dd>
            {row!.savingsUsd > 0 && (
              <>
                <dt className={LABEL}>Saved</dt>
                <dd className="octo-tabular m-0 truncate text-octo-sage" title="Saved vs an all-premium baseline">
                  {usd(row!.savingsUsd)}
                </dd>
              </>
            )}
          </dl>
        ) : (
          <p className="m-0 text-[11px] text-octo-mute">{loaded ? "No work recorded yet." : ""}</p>
        )}
      </div>
    </CompanionSection>
  );
}
