import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ipc, type SubagentTypeMeta } from "../lib/ipc";
import type { SkillMeta } from "../lib/types";
import { MENU_HEADER, MENU_ITEM_MULTILINE } from "../lib/menuStyles";
import { tourId } from "../lib/tour/ids";
import { useChatStore } from "../stores/chatStore";
import { MenuSurface } from "./MenuSurface";

export interface TalkCatalog {
  skills: SkillMeta[];
  agents: SubagentTypeMeta[];
}

const EMPTY: TalkCatalog = { skills: [], agents: [] };

/** Where a skill or agent definition comes from, as the popover says it:
 *  `built-in`, `project`, `user` (and whatever a later source is called). */
export function sourceLabel(source: string): string {
  return source === "builtin" ? "built-in" : source;
}

/** An agent's tier or model: the tier its alias names (`haiku` → fast), the
 *  model id as written, or Talk's own model when the definition sets none. */
export function agentModelLabel(model: string | null): string {
  const m = model?.trim() ?? "";
  if (!m || m.toLowerCase() === "inherit") return "Talk's model";
  const tier = { fast: "fast", haiku: "fast", balanced: "balanced", sonnet: "balanced", strong: "strong", opus: "strong" }[
    m.toLowerCase()
  ];
  return tier ? `${tier} tier` : m;
}

/** The workspace tools an agent may use; null is the full set. */
export function agentToolsLabel(tools: string[] | null): string {
  if (tools == null) return "every tool";
  return tools.length === 0 ? "no tools" : tools.join(", ");
}

/** The skills and sub-agent types Talk can use in this worktree, read with
 *  `list_skills` and `list_subagent_types` (`scan_agent_definitions`). The
 *  backend rescans both on every turn, so the lists re-read on a worktree
 *  change and when a turn starts or settles; the last reading stays while a
 *  reload runs, and a late answer for another worktree is dropped. */
export function useTalkCatalog(worktreePath: string | undefined, workspaceId: string): TalkCatalog {
  const streaming = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  const [catalog, setCatalog] = useState<TalkCatalog & { path?: string }>(EMPTY);
  const seq = useRef(0);

  useEffect(() => {
    const token = ++seq.current;
    if (!worktreePath) return;
    void Promise.all([
      ipc.listSkills(worktreePath).catch(() => null),
      ipc.listSubagentTypes(worktreePath).catch(() => null),
    ]).then(([skills, agents]) => {
      if (seq.current !== token) return;
      setCatalog((c) => {
        const same = c.path === worktreePath;
        return {
          path: worktreePath,
          skills: skills ?? (same ? c.skills : []),
          agents: agents ?? (same ? c.agents : []),
        };
      });
    });
  }, [worktreePath, streaming]);

  return catalog.path === worktreePath ? catalog : EMPTY;
}

/** A quiet `label · N` count that opens its list in a menu below it. */
function CatalogCount({
  label,
  count,
  tourId,
  title,
  menuLabel,
  children,
}: {
  label: string;
  count: number;
  tourId: string;
  title: string;
  menuLabel: string;
  children: (close: () => void) => ReactNode;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // A press on the count while its menu is open is an outside press for the
  // menu, which closes on it; the click that follows must not reopen it.
  const wasOpen = useRef(false);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-tour={tourId}
        title={title}
        onPointerDown={() => {
          wasOpen.current = anchor !== null;
        }}
        onClick={(e) => {
          if (wasOpen.current) {
            wasOpen.current = false;
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: r.left, y: r.bottom + 4 });
        }}
        className="octo-fade-in -mx-1 rounded px-1 font-mono text-[10px] text-octo-mute transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] hover:bg-[var(--brass-ghost)] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        {label} · {count}
      </button>
      {anchor && (
        <MenuSurface
          x={anchor.x}
          y={anchor.y}
          ariaLabel={menuLabel}
          onDismiss={close}
          widthClass="w-[288px] max-h-[360px] overflow-y-auto"
        >
          {children(close)}
        </MenuSurface>
      )}
    </>
  );
}

/** A row's first line: the name, then where it comes from. */
function NameLine({ name, source }: { name: string; source: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate text-octo-ivory">{name}</span>
      <span className="ml-auto shrink-0 text-[9px] text-octo-mute">{sourceLabel(source)}</span>
    </span>
  );
}

/**
 * The "can use" row's skills and agents counts: `skills · N` opens the
 * skills (a click adds `/name` to the draft, which runs it with that
 * message), `agents · N` the sub-agent types Talk's `Agent` tool can run
 * under, each with its tier or model and its tools. Read-only. A count is
 * left out at zero.
 */
export function CompanionCatalogCounts({ catalog, workspaceId }: { catalog: TalkCatalog; workspaceId?: string }) {
  const { skills, agents } = catalog;
  return (
    <>
      {skills.length > 0 && (
        <CatalogCount
          label="skills"
          count={skills.length}
          tourId={tourId("companion-can-use-skills")}
          title="Skills this conversation can run: write /name in a message, or pick one here"
          menuLabel="Skills"
        >
          {(close) => (
            <>
              <div className={MENU_HEADER}>skills · click one to add it</div>
              {skills.map((s) => (
                <button
                  key={`${s.source}:${s.name}`}
                  type="button"
                  role="menuitem"
                  disabled={!workspaceId}
                  title={`Add /${s.name} to your message${s.description ? ` · ${s.description}` : ""}`}
                  onClick={() => {
                    if (!workspaceId) return;
                    useChatStore.getState().queueDraftInsert(workspaceId, `/${s.name} `);
                    close();
                  }}
                  className={`${MENU_ITEM_MULTILINE} text-left`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <NameLine name={`/${s.name}`} source={s.source} />
                    {s.description && <span className="truncate font-sans text-[10px] text-octo-mute">{s.description}</span>}
                  </span>
                </button>
              ))}
            </>
          )}
        </CatalogCount>
      )}
      {agents.length > 0 && (
        <CatalogCount
          label="agents"
          count={agents.length}
          tourId={tourId("companion-can-use-agents")}
          title="Sub-agent types this conversation can hand work to"
          menuLabel="Sub-agent types"
        >
          {() => (
            <>
              <div className={MENU_HEADER}>sub-agent types</div>
              {agents.map((a) => {
                const model = agentModelLabel(a.model);
                const tools = agentToolsLabel(a.tools);
                return (
                  <div
                    key={`${a.source}:${a.name}`}
                    role="menuitem"
                    tabIndex={0}
                    title={`${a.name} · ${sourceLabel(a.source)} · ${model} · ${tools}${a.description ? `\n${a.description}` : ""}`}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 font-mono text-[11px] text-octo-sage focus-visible:bg-[var(--brass-ghost)] focus-visible:outline-none"
                  >
                    <NameLine name={a.name} source={a.source} />
                    {a.description && <span className="truncate font-sans text-[10px] text-octo-mute">{a.description}</span>}
                    <span className="truncate text-[10px] text-octo-mute">
                      {model} · {tools}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </CatalogCount>
      )}
    </>
  );
}
