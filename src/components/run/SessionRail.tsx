import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTerminalsStore } from "../../stores/terminalsStore";
import { useAttentionStore } from "../../stores/attentionStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { ROLE_WORD } from "../../lib/sessionRole";

interface Props {
  workspaceId: string;
}

/**
 * The Run canvas's session rail — the navigation for open terminals.
 *
 * Built from the grammar the app already uses twice (WorkspaceRail, HunkRail):
 * a slim column of cells with a reserved identity edge. Three rules from the
 * design record govern what a cell shows:
 *
 *  1. **The icon is the identity, the number is the address.** A 32px cell
 *     holds one glyph well and two badly, so it shows the session's role icon
 *     at rest and flips to its ⌘⌥N number while ⌥/⌘ is held. Nothing lives
 *     only behind that gesture — the number is permanent in the flyout, the
 *     Companion inspector and the ⌘⌥K switcher.
 *  2. **Roles are sticky** (see `terminalsStore.setBusy`).
 *  3. **One glyph, two facts:** the icon carries identity, its colour and edge
 *     carry state — brass active, marching brass while a command runs.
 *
 * Living in the canvas rather than the Companion is the point: collapsing the
 * Companion no longer removes the only way to change session.
 *
 * Design record: docs/superpowers/plans/2026-08-15-run-terminal-navigation-design.md
 */
export function SessionRail({ workspaceId }: Props) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const setActive = useTerminalsStore((s) => s.setActive);
  const createTerminal = useTerminalsStore((s) => s.createTerminal);
  const renameTerminal = useTerminalsStore((s) => s.renameTerminal);
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);
  const flag = useAttentionStore((s) => s.flagsByWs[workspaceId]);

  const ringingId = flag?.kind === "terminal" ? (flag.terminalId ?? null) : null;

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const peek = useModifierPeek();

  const startEdit = useCallback((id: string, label: string) => {
    setEditingId(id);
    setEditValue(label);
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingId) return;
    const trimmed = editValue.trim();
    if (trimmed) renameTerminal(workspaceId, editingId, trimmed).catch(console.error);
    setEditingId(null);
  }, [editingId, editValue, renameTerminal, workspaceId]);

  /** Roving focus, mirroring EditorTabs: arrows move, Enter/Space activates. */
  const onCellKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const keys = ["ArrowUp", "ArrowDown", "Home", "End", "Enter", " "];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Enter" || e.key === " ") {
      setActive(workspaceId, id);
      return;
    }
    const list = e.currentTarget.closest("[role='tablist']");
    if (!list) return;
    const cells = Array.from(list.querySelectorAll<HTMLElement>("[role='tab']"));
    const idx = cells.indexOf(e.currentTarget);
    if (idx === -1) return;
    let next = idx;
    if (e.key === "ArrowUp") next = Math.max(0, idx - 1);
    else if (e.key === "ArrowDown") next = Math.min(cells.length - 1, idx + 1);
    else if (e.key === "Home") next = 0;
    else next = cells.length - 1;
    cells[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Terminal sessions"
      aria-orientation="vertical"
      // Same geometry as Review's collapsed navigator rail (w-44px, one right
      // hairline, panel ground) — one canonical chrome per concept.
      className="octo-fade-in flex w-[44px] shrink-0 flex-col items-center gap-1 border-r border-octo-hairline bg-octo-panel py-2"
      // Flex siblings paint as atomic units, so the rail needs its own
      // stacking context to keep the hover flyout above the terminal.
      style={{ position: "relative", zIndex: 2 }}
    >
      {terminals.map((t, i) => {
        const active = t.id === activeId;
        const Icon = iconForSessionRole(t.role);
        const isEditing = t.id === editingId;
        const jump = i < 9 ? `⌘⌥${i + 1}` : null;
        const doing = t.busy && t.command ? t.command : ROLE_WORD[t.role];

        return (
          <div
            key={t.id}
            className="relative w-8"
            onMouseEnter={() => setHoverId(t.id)}
            onMouseLeave={() => {
              setHoverId((h) => (h === t.id ? null : h));
              if (editingId === t.id) setEditingId(null);
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-testid={`session-cell-${t.id}`}
              title={`${t.label} — ${doing}${jump ? ` (${jump})` : ""}`}
              onClick={() => setActive(workspaceId, t.id)}
              onKeyDown={(e) => onCellKeyDown(e, t.id)}
              onFocus={() => setHoverId(t.id)}
              className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-[180ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
                active
                  ? "bg-[var(--brass-ghost)] text-octo-brass"
                  : "text-octo-mute hover:bg-[var(--brass-faint)] hover:text-octo-sage"
              }`}
            >
              {peek ? (
                <span className="octo-tabular font-mono text-[12px]">{i + 1}</span>
              ) : (
                <Icon size={15} strokeWidth={1.75} aria-hidden />
              )}
            </button>

            {/* Identity edge — a reserved slot, so selection never shifts the
                cell by a pixel. Marching segments while a command runs, the
                same idiom (and class) as the workspace rail's activity bar. */}
            {t.busy ? (
              <span
                data-testid={`session-busy-${t.id}`}
                className="rail-bar-running"
                style={
                  {
                    ["--rail-bar" as string]: active
                      ? "var(--color-octo-brass)"
                      : "var(--brass-line)",
                    top: 4,
                    bottom: 4,
                  } as React.CSSProperties
                }
                title={t.command ?? "Running"}
              />
            ) : (
              <span
                aria-hidden
                className="absolute bottom-1 left-[-3px] top-1 w-[2px] rounded-sm transition-colors duration-[180ms]"
                style={{ background: active ? "var(--color-octo-brass)" : "transparent" }}
              />
            )}

            {/* Rang-while-hidden marker. Static, not pulsing: inside Run the
                mode switcher's pulse has already handed off, and Law 2 allows
                exactly one pulsing element per attention scope. */}
            {ringingId === t.id && t.id !== activeId && (
              <span
                data-testid={`session-bell-${t.id}`}
                className="octo-pop-in pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-octo-brass"
                title="This session rang while you were elsewhere"
              />
            )}

            {hoverId === t.id && (
              <div
                data-testid={`session-flyout-${t.id}`}
                className="octo-menu-enter absolute left-10 top-[-2px] z-30 min-w-[216px] rounded-lg border border-octo-hairline bg-octo-panel-2 px-3 py-2.5 shadow-[0_18px_40px_-22px_rgba(0,0,0,0.95)]"
              >
                {isEditing ? (
                  <input
                    autoFocus
                    data-testid={`session-rename-${t.id}`}
                    className="w-full rounded bg-transparent font-serif text-[13px] text-octo-ivory outline outline-1 outline-octo-brass"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingId(null);
                      }
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <Icon size={14} strokeWidth={1.75} className="shrink-0 text-octo-brass" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory">
                      {t.label}
                    </span>
                  </div>
                )}
                <div className="mt-1 truncate font-mono text-[10px] text-octo-mute" title={doing}>
                  {doing}
                </div>
                <div className="mt-2 flex items-center gap-3 border-t border-octo-hairline pt-2">
                  <button
                    type="button"
                    onClick={() => startEdit(t.id, t.label)}
                    className="font-mono text-[9px] uppercase tracking-[0.14em] text-octo-mute transition-colors hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    data-testid={`session-close-${t.id}`}
                    onClick={() => void deleteTerminal(workspaceId, t.id)}
                    className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.14em] text-octo-mute transition-colors hover:text-octo-rouge focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    <X size={10} strokeWidth={2} aria-hidden /> Close
                  </button>
                  {jump && (
                    <span className="ml-auto font-mono text-[9px] text-octo-mute">{jump}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => createTerminal(workspaceId).catch(console.error)}
        aria-label="New session"
        title="New session"
        data-testid="session-new"
        className="mt-auto flex h-7 w-7 items-center justify-center rounded text-octo-mute transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <Plus size={13} strokeWidth={1.75} aria-hidden />
      </button>
    </div>
  );
}

/**
 * True while ⌥ or ⌘ is held — the moment the rail swaps icons for jump
 * numbers. The hint arrives exactly when the hand is already on the modifier,
 * and window blur resets it so a Cmd-Tab away can't leave the rail stuck.
 */
function useModifierPeek(): boolean {
  const [peek, setPeek] = useState(false);
  const peekRef = useRef(peek);
  peekRef.current = peek;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const next = e.altKey || e.metaKey;
      if (next !== peekRef.current) setPeek(next);
    };
    const off = () => {
      if (peekRef.current) setPeek(false);
    };
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  return peek;
}
