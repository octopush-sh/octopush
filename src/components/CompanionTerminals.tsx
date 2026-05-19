import { useState, useRef, useCallback, useEffect } from "react";
import { useTerminalsStore } from "../stores/terminalsStore";

// Re-export for backward-compat with Companion.tsx type imports.
export interface CompanionTerminal {
  id: string;
  label: string;
  meta: string;
}

interface Props {
  workspaceId: string;
}

export function CompanionTerminals({ workspaceId }: Props) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const activeTerminalId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const setActive = useTerminalsStore((s) => s.setActive);
  const createTerminal = useTerminalsStore((s) => s.createTerminal);
  const renameTerminal = useTerminalsStore((s) => s.renameTerminal);
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);
  const clearRestored = useTerminalsStore((s) => s.clearRestored);

  // Auto-dismiss `restored` badges after 5 seconds.
  useEffect(() => {
    const restoredIds = terminals.filter((t) => t.restored).map((t) => t.id);
    if (restoredIds.length === 0) return;
    const timers = restoredIds.map((id) =>
      setTimeout(() => clearRestored(workspaceId, id), 5000),
    );
    return () => timers.forEach(clearTimeout);
  }, [
    // Re-run when the set of restored ids changes. We use a stable string key
    // to avoid re-triggering when other terminal props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    terminals.map((t) => (t.restored ? t.id : "")).join(","),
    workspaceId,
    clearRestored,
  ]);

  // id of the terminal whose label is currently being edited
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback((id: string, currentLabel: string) => {
    setEditingId(id);
    setEditValue(currentLabel);
    // Focus after next paint so the input is mounted.
    requestAnimationFrame(() => {
      inputRef.current?.select();
    });
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingId) return;
    const trimmed = editValue.trim();
    if (trimmed) {
      renameTerminal(workspaceId, editingId, trimmed).catch(console.error);
    }
    setEditingId(null);
  }, [editingId, editValue, workspaceId, renameTerminal]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  return (
    <section>
      <div className="flex items-center justify-between border-b border-octo-hairline pb-2">
        <h3 className="font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
          Terminals
        </h3>
        <button
          type="button"
          onClick={() => createTerminal(workspaceId).catch(console.error)}
          className="font-mono text-[10px] text-octo-mute transition hover:text-octo-brass"
          title="New terminal"
        >
          +
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {terminals.length === 0 && (
          <li className="px-2 py-1 text-[11px] italic text-octo-mute">No active terminals.</li>
        )}
        {terminals.map((t) => {
          const active = t.id === activeTerminalId;
          const isEditing = t.id === editingId;

          return (
            <li key={t.id} className="group relative">
              <button
                type="button"
                onClick={() => {
                  if (!active) setActive(workspaceId, t.id);
                }}
                className="w-full rounded-md px-2 py-1.5 text-left transition"
                style={
                  active
                    ? { borderLeft: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }
                    : undefined
                }
              >
                <div className="flex items-center gap-1.5">
                  {/* Status dot: brass when running, muted when stopped */}
                  <span
                    data-testid={`status-dot-${t.id}`}
                    className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{
                      background: t.running ? "var(--brass)" : "var(--octo-mute)",
                    }}
                    title={t.running ? "Running" : "Stopped"}
                  />

                  {/* Label — double-click to rename */}
                  {isEditing ? (
                    <input
                      ref={inputRef}
                      data-testid={`rename-input-${t.id}`}
                      className="min-w-0 flex-1 rounded bg-transparent font-serif italic text-[12px] leading-tight text-octo-ivory outline outline-1 outline-octo-brass"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitEdit();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          cancelEdit();
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span
                      data-testid={`label-${t.id}`}
                      className="min-w-0 flex-1 truncate font-serif italic text-[12px] leading-tight text-octo-ivory"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startEdit(t.id, t.label);
                      }}
                    >
                      {t.label}
                    </span>
                  )}

                  {/* Restored badge — transient, auto-dismissed after 5s */}
                  {t.restored && !isEditing && (
                    <span
                      data-testid={`restored-badge-${t.id}`}
                      className="flex-shrink-0 font-mono text-[9px] uppercase tracking-[0.25em]"
                      style={{ color: "var(--brass-dim)" }}
                      title="Session restored from previous Octopush run"
                    >
                      ↺ Restored
                    </span>
                  )}

                  {/* Delete button — visible on hover, sized for a real
                      tap target (20×20). */}
                  {!isEditing && (
                    <button
                      type="button"
                      data-testid={`delete-btn-${t.id}`}
                      className="ml-auto flex h-5 w-5 flex-shrink-0 items-center justify-center rounded font-mono text-[14px] leading-none text-octo-mute opacity-0 transition hover:bg-octo-rouge/15 hover:text-octo-rouge group-hover:opacity-100"
                      title="Close terminal"
                      aria-label="Close terminal"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteTerminal(workspaceId, t.id).catch(console.error);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* `pl-3` lines up the meta text with the start of the
                    label above (dot 6px + gap 6px = 12px). */}
                <div className="mt-0.5 pl-3 font-mono text-[8px] uppercase tracking-[0.15em] text-octo-mute">
                  {t.running ? "RUNNING" : "STOPPED"}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
