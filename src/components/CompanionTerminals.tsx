import { useState, useRef, useCallback } from "react";
import { Plus, X } from "lucide-react";
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
      {/* Eyebrow bar — converges on the CompanionFileTree quality bar. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Terminals
        </h3>
        <button
          type="button"
          onClick={() => createTerminal(workspaceId).catch(console.error)}
          aria-label="New terminal"
          title="New terminal"
          className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <Plus size={12} />
        </button>
      </div>
      {/* Body inset matches CompanionFileTree's (px-2 py-2) — the bar above
          stays full-bleed. */}
      <ul className="space-y-1 px-2 py-2">
        {terminals.length === 0 && (
          <li className="px-2 py-1 text-[11px] text-octo-mute">No active terminals.</li>
        )}
        {terminals.map((t) => {
          const active = t.id === activeTerminalId;
          const isEditing = t.id === editingId;

          // Status dot — brass when running, muted when stopped. Its `title`
          // carries the state; no meta line needed.
          const dot = (
            <span
              data-testid={`status-dot-${t.id}`}
              className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
              style={{
                background: t.running
                  ? "var(--color-octo-brass)"
                  : "var(--color-octo-mute)",
              }}
              title={t.running ? "Running" : "Stopped"}
            />
          );

          return (
            <li key={t.id}>
              {/* Row: outer div so the select and delete buttons are valid
                  siblings (no button-in-button nesting). The border-l slot is
                  always reserved — transparent when inactive — so selection
                  never shifts layout by 1px. */}
              <div
                className={`octo-rise-in group relative flex items-center rounded-md border-l pr-1 transition-colors duration-[220ms] hover:bg-[var(--brass-ghost)] ${
                  active
                    ? "border-l-[color:var(--brass-dim)] bg-[var(--brass-ghost)]"
                    : "border-l-transparent"
                }`}
              >
                {isEditing ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5">
                    {dot}
                    <input
                      ref={inputRef}
                      data-testid={`rename-input-${t.id}`}
                      className="min-w-0 flex-1 rounded bg-transparent font-serif text-[12px] leading-tight text-octo-ivory outline outline-1 outline-octo-brass"
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
                      autoFocus
                    />
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (!active) setActive(workspaceId, t.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                    >
                      {dot}

                      {/* Label — double-click to rename */}
                      <span
                        data-testid={`label-${t.id}`}
                        className="min-w-0 flex-1 truncate font-serif text-[12px] leading-tight text-octo-ivory"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startEdit(t.id, t.label);
                        }}
                      >
                        {t.label}
                      </span>

                      {/* Restored badge — transient; the store clears the
                          flag 5s after a reattach-load. */}
                      {t.restored && (
                        <span
                          data-testid={`restored-badge-${t.id}`}
                          className="octo-pop-in flex-shrink-0 font-mono text-[9px] uppercase tracking-[0.25em]"
                          style={{ color: "var(--brass-dim)" }}
                          title="Session restored from previous Octopush run"
                        >
                          ↺ Restored
                        </span>
                      )}
                    </button>

                    {/* Delete — sibling of the select button. Hidden until
                        hover or keyboard focus; rouge preserves destructive
                        intent. */}
                    <button
                      type="button"
                      data-testid={`delete-btn-${t.id}`}
                      className="flex flex-shrink-0 items-center justify-center rounded p-1 text-octo-mute opacity-0 transition hover:bg-octo-rouge/15 hover:text-octo-rouge focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass group-hover:opacity-100"
                      title="Close terminal"
                      aria-label="Close terminal"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteTerminal(workspaceId, t.id);
                      }}
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
