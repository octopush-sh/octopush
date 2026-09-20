import { useEffect, useRef, useState } from "react";
import { Wand2, Server, Maximize2 } from "lucide-react";
import type { Budget, BudgetPeriod, BudgetScope, SpendSnapshot, ThreadCost } from "../lib/types";
import { ipc } from "../lib/ipc";
import { useChatStore } from "../stores/chatStore";
import { useMissionLogbook } from "../hooks/useMissionLogbook";
import { fmtHours } from "../lib/logbook";
import { CompanionSection } from "./CompanionSection";

interface Props {
  tokensUsed: number;
  tokensLimit: number;
  unstaged: number;
  toolCalls: number;
  /** Active workspace id — for workspace-level spend lookups */
  workspaceId?: string;
  budgets?: Budget[];
  spend?: Record<string, SpendSnapshot>;
  /** Active skill for the conversation, if any (capabilities row). */
  activeSkill?: string | null;
  /** Connected MCP servers for the workspace (capabilities row). */
  mcpServers?: string[];
  /** Jump to Review mode (e.g. clicking the unstaged-changes row). */
  onReviewClick?: () => void;
  /** Open Settings (e.g. clicking a spending row to manage budgets). */
  onSettingsClick?: () => void;
  /** Open the Logbook Room (the mission line is its teaser). */
  onOpenLogbook?: () => void;
}

/** `$4.20` — three decimals under a cent so a cheap turn never reads as free. */
export function usd(n: number): string {
  return `$${n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** The cost lines of a conversation from its ledger figures. Pure so the
 *  wording is tested: spent (sub-agents' share aside), and the saving
 *  against every token running on the strong tier — only when that tier is
 *  priced and the saving is real. */
export function costLines(cost: ThreadCost | null): Array<{ key: string; label: string; value: string; tone: "brass" | "sage" | "verdigris" }> {
  if (!cost || cost.calls <= 0) return [];
  const lines: Array<{ key: string; label: string; value: string; tone: "brass" | "sage" | "verdigris" }> = [
    { key: "spent", label: "spent", value: usd(cost.spentUsd), tone: "brass" },
  ];
  if (cost.subagentsUsd > 0) {
    lines.push({ key: "agents", label: "of which sub-agents", value: usd(cost.subagentsUsd), tone: "sage" });
  }
  if (cost.strongPriced && cost.baselineUsd > cost.spentUsd) {
    const saved = cost.baselineUsd - cost.spentUsd;
    const pct = Math.round((saved / cost.baselineUsd) * 100);
    lines.push({ key: "saved", label: "saved vs all-strong", value: `${usd(saved)} · ${pct}%`, tone: "verdigris" });
  }
  return lines;
}

/**
 * The Conversation section — everything about the thread on screen in one
 * place: how full its context is, what it has cost (from the ledger, so the
 * figure matches Settings › Usage: director rounds and sub-agent runs,
 * cache-aware), the mission's logbook line, what it can use (skill, MCP
 * servers) and the budgets it counts against. One eyebrow, quiet labels,
 * no boxes inside boxes.
 */
export function CompanionContext({
  tokensUsed,
  tokensLimit,
  unstaged,
  toolCalls,
  workspaceId,
  budgets = [],
  spend = {},
  activeSkill,
  mcpServers = [],
  onReviewClick,
  onSettingsClick,
  onOpenLogbook,
}: Props) {
  const pct = tokensLimit > 0 ? Math.min(100, (tokensUsed / tokensLimit) * 100) : 0;
  // Warn as the context window fills — amber past 80%, rouge past 95%.
  const tokenColor =
    pct >= 95
      ? "var(--color-octo-rouge)"
      : pct >= 80
        ? "var(--color-octo-warning)"
        : "var(--color-octo-brass)";

  const cost = useThreadCost(workspaceId ?? "");
  const logbook = useMissionLogbook(workspaceId ?? "");
  const spendingRows = buildSpendingRows(budgets, spend, workspaceId ?? "");
  const hasCapabilities = !!activeSkill || mcpServers.length > 0;
  const lines = costLines(cost);
  const logbookHasWork = !!logbook.row && (logbook.row.hoursSecs > 0 || logbook.row.costUsd > 0);

  return (
    <CompanionSection title="Conversation" storageKey="conversation" testId="companion-conversation">
      <div className="px-4 pb-3 pt-1 text-[11px] text-octo-sage">
        {/* Context meter */}
        <Row
          label="context"
          value={`${formatThousands(tokensUsed)} / ${formatThousands(tokensLimit)}`}
          valueColor={tokenColor}
          title={
            pct >= 80
              ? `${Math.round(pct)}% of the context window used — consider a new conversation`
              : "The last prompt's size against the model's context window"
          }
        />
        <div className="mt-1.5 h-[3px] rounded-sm" style={{ background: "var(--color-octo-hairline)" }}>
          <div
            className="h-full rounded-sm transition-[width] duration-[220ms]"
            style={{ width: `${pct}%`, background: tokenColor }}
          />
        </div>

        {/* Cost — from the ledger, so it agrees with Settings › Usage. */}
        {lines.length > 0 && (
          <div className="octo-fade-in mt-3 space-y-1" data-testid="conversation-cost">
            {lines.map((l) => (
              <Row
                key={l.key}
                label={l.label}
                value={l.value}
                valueColor={
                  l.tone === "brass"
                    ? "var(--color-octo-brass)"
                    : l.tone === "verdigris"
                      ? "var(--color-octo-verdigris)"
                      : "var(--color-octo-sage)"
                }
                title={
                  l.key === "spent" && cost?.cacheHitPct != null
                    ? `${cost.calls} model calls · ${Math.round(cost.cacheHitPct)}% of the prompt served from the cache`
                    : l.key === "saved"
                      ? "What the same tokens would have cost with every call on the strong tier"
                      : undefined
                }
              />
            ))}
          </div>
        )}

        <div className="mt-3 space-y-1">
          <Row
            label="unstaged"
            value={String(unstaged)}
            onClick={unstaged > 0 ? onReviewClick : undefined}
            title={unstaged > 0 && onReviewClick ? "Review changes" : undefined}
          />
          <Row label="tool calls" value={String(toolCalls)} />
          {logbook.missionId && (
            <Row
              label="mission"
              value={
                logbookHasWork
                  ? `${fmtHours(logbook.row!.hoursSecs)} · ${usd(logbook.row!.costUsd)}${
                      logbook.row!.savingsUsd > 0 ? ` · saved ${usd(logbook.row!.savingsUsd)}` : ""
                    }`
                  : logbook.loaded
                    ? "no work yet"
                    : ""
              }
              title="This mission's worked time and spend — the Logbook"
              onClick={onOpenLogbook}
              trailing={
                onOpenLogbook ? (
                  <Maximize2 size={10} aria-hidden className="ml-1.5 shrink-0 text-octo-mute" />
                ) : null
              }
            />
          )}
        </div>

        {/* Capabilities — the skill + MCP servers this conversation can use. */}
        {hasCapabilities && (
          <div className="octo-rise-in mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-octo-sage">can use</span>
            {activeSkill && (
              <span className="flex items-center gap-1 text-[10px]" title="Active skill">
                <Wand2 size={10} className="shrink-0 text-octo-brass" />
                <span className="font-mono text-octo-ivory">{activeSkill}</span>
              </span>
            )}
            {mcpServers.map((s) => (
              <span key={s} className="flex items-center gap-1 text-[10px]" title="MCP server">
                <Server size={10} className="shrink-0 text-octo-brass" />
                <span className="font-mono text-octo-ivory">{s}</span>
              </span>
            ))}
          </div>
        )}

        {/* Budgets — only when one exists (an empty block earns no space). */}
        {spendingRows.length > 0 && (
          <div className="octo-rise-in mt-3 space-y-2">
            {spendingRows.map((row) => (
              <SpendRow key={row.key} row={row} onClick={onSettingsClick} />
            ))}
          </div>
        )}
      </div>
    </CompanionSection>
  );
}

/** The active thread's ledger cost, re-read when a turn settles, a row
 *  lands, or a sub-agent continuation ends — the edges that add spend. */
function useThreadCost(workspaceId: string): ThreadCost | null {
  const threadId = useChatStore((s) => (workspaceId ? s.activeThreadByWs[workspaceId] ?? null : null));
  const streaming = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  const messageCount = useChatStore((s) => (s.messagesByWs[workspaceId] ?? []).length);
  const continuing = useChatStore((s) => Object.keys(s.continuingCalls).length);
  const [cost, setCost] = useState<ThreadCost | null>(null);
  const seq = useRef(0);
  const prevThread = useRef<string | null>(null);

  useEffect(() => {
    if (!threadId) {
      seq.current += 1;
      prevThread.current = null;
      setCost(null);
      return;
    }
    if (prevThread.current !== threadId) {
      prevThread.current = threadId;
      setCost(null);
    }
    const token = ++seq.current;
    void ipc
      .getThreadCost(threadId)
      .then((c) => {
        if (seq.current === token) setCost(c);
      })
      .catch(() => {
        /* the meter and the rest of the section stand without it */
      });
  }, [threadId, streaming, messageCount, continuing]);

  return cost;
}

interface SpendRowData {
  key: string;
  label: string;
  costUsd: number;
  limitUsd: number;
  period: string;
}

function buildSpendingRows(
  budgets: Budget[],
  spend: Record<string, SpendSnapshot>,
  workspaceId: string,
): SpendRowData[] {
  const rows: SpendRowData[] = [];
  const seen = new Set<string>();

  // Priority: workspace > global for each period
  const scopes: Array<{ scope: BudgetScope; scopeId: string }> = [];
  if (workspaceId) {
    scopes.push({ scope: "workspace", scopeId: workspaceId });
  }
  scopes.push({ scope: "global", scopeId: "" });

  for (const period of ["daily", "monthly"] as BudgetPeriod[]) {
    // Find the most specific budget for this period
    for (const { scope, scopeId } of scopes) {
      const budget = budgets.find(
        (b) => b.scopeType === scope && b.scopeId === scopeId && b.period === period,
      );
      if (!budget) continue; // try next scope

      const key = `${scope}:${scopeId}:${period}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const snap = spend[key];
      const periodLabel = period === "daily" ? "today" : "this month";
      rows.push({
        key,
        label: `budget · ${periodLabel}`,
        costUsd: snap?.costUsd ?? 0,
        limitUsd: budget.limitUsd,
        period,
      });
      break; // only most specific for this period
    }
  }

  return rows;
}

function SpendRow({ row, onClick }: { row: SpendRowData; onClick?: () => void }) {
  const pct = row.limitUsd > 0 ? Math.min(100, (row.costUsd / row.limitUsd) * 100) : 0;
  const barColor = pct >= 100
    ? "var(--color-octo-rouge)"
    : pct >= 80
    ? "var(--color-octo-warning)"
    : "var(--color-octo-brass)";

  const body = (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-octo-sage">{row.label}</span>
        <span className="octo-tabular font-mono text-[10px] text-octo-ivory">
          ${row.costUsd.toFixed(2)} / ${row.limitUsd.toFixed(2)}
        </span>
      </div>
      <div
        className="mt-1 h-[3px] rounded-sm"
        style={{ background: "var(--color-octo-hairline)" }}
      >
        <div
          className="h-full rounded-sm transition-[width] duration-[220ms]"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
    </>
  );

  if (!onClick) return <div>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Manage budgets in Settings"
      className="w-full rounded text-left transition-colors hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      {body}
    </button>
  );
}

function Row({
  label,
  value,
  valueColor,
  onClick,
  title,
  trailing,
}: {
  label: string;
  value: string;
  valueColor?: string;
  onClick?: () => void;
  title?: string;
  trailing?: React.ReactNode;
}) {
  const content = (
    <>
      <span className="shrink-0">{label}</span>
      <span className="flex min-w-0 items-center justify-end">
        <span
          className="octo-tabular truncate font-mono text-[10px]"
          style={{ color: valueColor ?? "var(--color-octo-ivory)" }}
        >
          {value}
        </span>
        {trailing}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className="flex items-baseline justify-between gap-3" title={title}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="-mx-1 flex w-[calc(100%+0.5rem)] items-baseline justify-between gap-3 rounded px-1 text-left transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      {content}
    </button>
  );
}

function formatThousands(n: number): string {
  // Millions branch matters: the target model has a 1M context window, which
  // must read "1M", not "1000k".
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
