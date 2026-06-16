import { Lock, Plus } from "lucide-react";
import { useRolesStore } from "../../stores/rolesStore";
import { archetypes } from "./graph";
import { ARTIFACT_ICON } from "./icons";

export const ARCHETYPE_DND_MIME = "application/octopush-archetype";

interface Props {
  /** Click-to-add fallback (drag-and-drop is the primary gesture). */
  onAdd: (role: string) => void;
  /** Opens the Role Editor to create a new role. Will be wired in Task 9. */
  onNewRole?: () => void;
}

/** Group label ordering for the palette. */
const GROUP_ORDER = ["Plan & design", "Build", "Review", "Action", "Your roles"] as const;
type GroupName = (typeof GROUP_ORDER)[number];

function groupFor(role: string, environment: string, isBuiltin: boolean): GroupName {
  if (!isBuiltin) return "Your roles";
  if (environment === "action") return "Action";
  // Classify built-ins by role key convention
  if (["plan", "architect", "refine", "critique"].includes(role)) return "Plan & design";
  if (["implement", "fix", "test"].includes(role)) return "Build";
  return "Review";
}

/** The well of stage archetypes. Drag one onto the canvas, or click to drop it
 *  at the center. Built-in roles are marked with a lock; custom roles show a
 *  "custom" badge. Groups: Plan & design / Build / Review / Action / Your roles. */
export function NodePalette({ onAdd, onNewRole }: Props) {
  const { roles, loaded } = useRolesStore();
  const all = archetypes();

  // Build grouped list. When roles are not yet loaded we render a placeholder.
  const grouped: Record<GroupName, typeof all> = {
    "Plan & design": [],
    Build: [],
    Review: [],
    Action: [],
    "Your roles": [],
  };

  if (loaded && all.length > 0) {
    for (const a of all) {
      const role = roles.find((r) => r.key === a.role);
      const env = role?.environment ?? "worktree";
      const isBuiltin = role?.isBuiltin ?? true;
      const group = groupFor(a.role, env, isBuiltin);
      grouped[group].push(a);
    }
  }

  return (
    <div className="octo-fade-in flex w-[188px] flex-col gap-1 rounded-lg border border-octo-hairline bg-octo-panel/95 p-2 backdrop-blur-sm">
      <p className="px-1 pb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">Stages</p>

      {!loaded && (
        <p className="px-2 py-2 font-mono text-[10px] text-octo-mute">Loading roles…</p>
      )}

      {loaded && (
        <div className="flex max-h-[56vh] flex-col gap-0.5 overflow-y-auto">
          {GROUP_ORDER.map((group) => {
            const items = grouped[group];
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <p className="mb-0.5 mt-1.5 px-2 font-mono text-[8px] uppercase tracking-[0.22em] text-octo-mute first:mt-0">
                  {group}
                </p>
                {items.map((a) => {
                  const role = roles.find((r) => r.key === a.role);
                  const isBuiltin = role?.isBuiltin ?? true;
                  const Icon = ARTIFACT_ICON[a.artifact];
                  return (
                    <button
                      key={a.role}
                      type="button"
                      title={a.description}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(ARCHETYPE_DND_MIME, a.role);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => onAdd(a.role)}
                      className="group flex cursor-grab items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors duration-[150ms] hover:bg-[var(--brass-ghost)] active:cursor-grabbing"
                    >
                      <span className="text-octo-sage transition-colors duration-[150ms] group-hover:text-octo-brass">
                        <Icon size={13} strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory">{a.label}</span>
                      {isBuiltin ? (
                        <span className="shrink-0 text-octo-mute" title="Built-in role">
                          <Lock size={9} strokeWidth={1.75} />
                        </span>
                      ) : (
                        <span className="shrink-0 font-mono text-[8px] text-octo-brass" title="Custom role">
                          custom
                        </span>
                      )}
                      {a.canLoop && (
                        <span className="ml-0 shrink-0 font-mono text-[9px] text-octo-mute" title="Can loop work back">
                          ⟜
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* New role button — wired to onNewRole (Task 9 will implement the editor) */}
      <div className="mt-1 border-t border-octo-hairline pt-1">
        <button
          type="button"
          onClick={onNewRole}
          title="Create a custom role"
          className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 font-mono text-[10px] text-octo-mute transition-colors duration-[150ms] hover:text-octo-brass"
        >
          <Plus size={11} strokeWidth={1.75} />
          New role
        </button>
      </div>
    </div>
  );
}
