import { Command } from "cmdk";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { flushSync } from "react-dom";
import { useSessionStore } from "../stores/sessionStore";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import type { ModelWithProvider, SessionTemplate } from "../lib/types";
import { useThemeStore } from "../stores/themeStore";
import { useUpdaterStore } from "../stores/updaterStore";
import { useEditorPrefs } from "../stores/editorPrefsStore";
import { useBlameStore } from "../stores/blameStore";
import { ModalShell } from "./ModalShell";
import { openWhatsNewForCurrentVersion, previewUnreleasedTips } from "../lib/whatsNewLaunch";
import { tourId } from "../lib/tour/ids";
import { useCrewImportStore } from "../stores/crewImportStore";
import { useRunsStore } from "../stores/runsStore";
import { MidTruncate } from "./primitives/MidTruncate";
import { paletteFilter, paletteWorkspaces, WORKSPACE_VALUE_PREFIX, type PaletteWorkspace } from "../lib/paletteWorkspaces";
import type { ProjectGroup } from "./WorkspaceRail";
import { firstRevealedModel, paletteModelValue, paletteModels } from "../lib/paletteModels";
import { GROUP_VALUE_PREFIX, paletteGroups, type PaletteGroup } from "../lib/paletteGroups";
import { useGroupsStore } from "../stores/groupsStore";
import { groupMarkColor } from "./RailMissionGroup";
import { ChevronDown } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onToggleTokens: () => void;
  /** Opens the PR composer for the active workspace; absent without one. */
  onOpenPullRequest?: () => void;
  /** The rail's projects and their workspaces — the Workspaces group. */
  projects?: ProjectGroup[];
  /** Workspaces something is working in (the rail's marching edge). */
  runningByWs?: Record<string, boolean>;
  /** Switches project and workspace like a rail click. */
  onSelectWorkspace?: (id: string) => void;
  /** Reveals a rail group (unfolds it, scrolls to it, focuses its header).
   *  The Groups section shows only when this is wired. */
  onRevealGroup?: (groupId: string) => void;
}

export function CommandPalette({
  open,
  onClose,
  onNewSession,
  onToggleTokens,
  onOpenPullRequest,
  projects,
  runningByWs,
  onSelectWorkspace,
  onRevealGroup,
}: Props) {
  const { sessions, activeId, select, kill } = useSessionStore();
  const refresh = useSessionStore((s) => s.refresh);
  const [models, setModels] = useState<ModelWithProvider[]>([]);
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const { themes, apply: applyTheme } = useThemeStore();
  const editorWrap = useEditorPrefs((s) => s.wrap);
  const editorFontSize = useEditorPrefs((s) => s.fontSize);
  const editorTabWidth = useEditorPrefs((s) => s.tabWidth);
  const editorLineNumbers = useEditorPrefs((s) => s.lineNumbers);
  const blameOn = useBlameStore((s) => s.enabled);
  const runsByWs = useRunsStore((s) => s.runsByWs);
  const statusSince = useRunsStore((s) => s.statusSince);
  const groups = useGroupsStore((s) => s.groups);
  const workspaceRows = useMemo(
    () => (open && onSelectWorkspace ? paletteWorkspaces(projects, runsByWs, statusSince, runningByWs, groups) : []),
    [open, onSelectWorkspace, projects, runsByWs, statusSince, runningByWs, groups],
  );
  const groupRows = useMemo(
    () => (open && onRevealGroup ? paletteGroups(projects, groups) : []),
    [open, onRevealGroup, projects, groups],
  );

  const [search, setSearch] = useState("");
  const [allModels, setAllModels] = useState(false);
  // cmdk's selection, controlled so "Show all models" can hand it to the
  // first revealed model (#897).
  const [selected, setSelected] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // The palette stays mounted while closed (it renders nothing), so reset on
  // close: a reopen must never paint the old query or expanded list for a
  // frame before an open-time reset lands (#897).
  useEffect(() => {
    if (open) {
      ipc.listModels().then(setModels).catch(() => {});
      ipc.listTemplates().then(setTemplates).catch(() => {});
    } else {
      setSearch("");
      setAllModels(false);
      setSelected("");
    }
  }, [open]);

  const run = useCallback(
    (fn: () => void | Promise<void>) => {
      onClose();
      fn();
    },
    [onClose],
  );

  if (!open) return null;

  const activeSession = sessions.find((s) => s.id === activeId);
  const modelRows = paletteModels(models, search, allModels, activeSession?.agent.model);

  // Groups — every rail group, in the rail's order. Choosing one reveals it
  // in the rail and focuses its header, where the group's own keys (F2,
  // ⇧F10, ←/→) take over: the palette is navigation only, it renames and
  // moves nothing itself.
  const groupsSection = groupRows.length > 0 && onRevealGroup && (
    <Group heading="Groups" tour={tourId("palette-groups")}>
      {groupRows.map((g) => (
        <GroupItem key={g.id} row={g} onSelect={() => run(() => onRevealGroup(g.id))} />
      ))}
    </Group>
  );

  return (
    <ModalShell onClose={onClose} align="top" topOffset="pt-[18vh]" ariaLabel="Command palette">
      <div
        className="w-[560px] rounded-xl bg-octo-panel"
        style={{
          border: "1px solid var(--brass-dim)",
          boxShadow:
            "0 30px 60px -10px rgba(0,0,0,0.6), 0 0 0 6px rgba(212, 165, 116, 0.04)",
        }}
      >
        <Command
          loop
          filter={paletteFilter}
          value={selected}
          onValueChange={setSelected}
          className="overflow-hidden rounded-xl"
        >
          <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
            <span className="font-mono text-[11px] text-octo-brass">⌘ K</span>
            <Command.Input
              data-tour="palette-input"
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Type a command, or search…"
              className="flex-1 bg-transparent font-serif text-[14px] text-octo-ivory outline-none placeholder:text-octo-mute"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute transition-colors hover:border-octo-brass hover:text-octo-brass"
            >
              ESC
            </button>
          </div>

          <Command.List ref={listRef} className="max-h-[380px] overflow-y-auto py-2">
            <Command.Empty className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
              Nothing matches.
            </Command.Empty>

            {/* Sessions */}
            <Group heading="Sessions">
              <Item glyph="+" label="New session" onSelect={() => run(onNewSession)} />
              {sessions.map((s) => (
                <Item
                  key={s.id}
                  glyph={s.name.charAt(0).toUpperCase() || "?"}
                  label={`Switch to ${s.name}`}
                  detail={s.agent.model}
                  onSelect={() => run(() => select(s.id))}
                />
              ))}
              {activeSession && (
                <Item
                  glyph="×"
                  label={`Kill ${activeSession.name}`}
                  onSelect={() =>
                    run(async () => {
                      await kill(activeSession.id);
                    })
                  }
                />
              )}
            </Group>

            {/* With a query, Groups come before Workspaces: a group's name
                also finds its missions, and the group itself is the likelier
                target. At rest the Workspaces, by recency, lead. */}
            {search.trim() !== "" && groupsSection}

            {/* Workspaces — every open project's, needs-you first, then
                running, then most recently active. Typing part of a branch
                or a project name finds the row. */}
            {workspaceRows.length > 0 && onSelectWorkspace && (
              <Group heading="Workspaces" tour={tourId("palette-workspaces")}>
                {workspaceRows.map((w) => (
                  <WorkspaceItem key={w.id} row={w} onSelect={() => run(() => onSelectWorkspace(w.id))} />
                ))}
              </Group>
            )}

            {search.trim() === "" && groupsSection}

            {/* Models */}
            {/* The heading already says "Models", so rows carry the bare name.
                With no query it is a short preview (#850); typing searches
                every model. */}
            <Group heading="Models" tour={tourId("palette-models")}>
              {modelRows.shown.map((m) => (
                <Item
                  key={m.model.id}
                  value={paletteModelValue(m)}
                  keywords={[m.model.displayName, m.provider]}
                  glyph="◇"
                  label={m.model.displayName}
                  detail={`${m.provider} · $${m.model.inputCostPerM}/M in`}
                  onSelect={() =>
                    run(async () => {
                      if (activeId) {
                        const result = await ipc.switchAgent(activeId, m.model.id);
                        await refresh();
                        pushToast({
                          level: result.appliedToPty ? "success" : "info",
                          title: `Model → ${m.model.displayName}`,
                          body: result.message,
                        });
                      }
                    })
                  }
                />
              ))}
              {modelRows.hidden > 0 && (
                <Item
                  glyph="⋯"
                  label="Show all models"
                  detail={`${modelRows.hidden} more`}
                  tour={tourId("palette-models-more")}
                  onSelect={() => {
                    // If this row were still selected when it unmounts, cmdk
                    // would re-select the palette's first item ("New
                    // session") (#897). So park the selection on the last
                    // shown model, reveal, then select the first revealed
                    // row through cmdk itself. A controlled `value` change
                    // moves aria-selected but not cmdk's aria-activedescendant
                    // (cmdk 1.1 recomputes it only when it selects a row), so
                    // setting the value alone would leave assistive tech on
                    // this removed row.
                    const next = firstRevealedModel(models, modelRows.shown);
                    const park = modelRows.shown[modelRows.shown.length - 1];
                    if (!next || !park) {
                      setAllModels(true);
                      return;
                    }
                    flushSync(() => setSelected(paletteModelValue(park)));
                    flushSync(() => setAllModels(true));
                    selectRow(listRef.current, paletteModelValue(next));
                  }}
                />
              )}
            </Group>

            {/* Templates */}
            {templates.length > 0 && (
              <Group heading="Templates">
                {templates.map((t) => (
                  <Item
                    key={t.name}
                    glyph="❦"
                    label={`Template: ${t.name}`}
                    detail={t.projectRoot}
                    onSelect={() => run(onNewSession)}
                  />
                ))}
              </Group>
            )}

            {/* Actions */}
            <Group heading="Actions">
              {onOpenPullRequest && (
                <Item
                  glyph="↗"
                  label="Open a pull request"
                  shortcut="⌘⇧P"
                  onSelect={() => run(onOpenPullRequest)}
                />
              )}
              <Item
                glyph="↓"
                label="Import a crew…"
                detail=".octocrew.json"
                tour={tourId("palette-import-crew")}
                onSelect={() => run(() => useCrewImportStore.getState().show())}
              />
              <Item
                glyph="↺"
                label="Check for updates"
                onSelect={() =>
                  run(async () => {
                    const store = useUpdaterStore.getState();
                    await store.checkForUpdates(true);
                    const next = useUpdaterStore.getState();
                    if (next.phase === "no-update") {
                      pushToast({
                        level: "success",
                        title: "Up to date",
                        body: next.currentVersion
                          ? `You're on v${next.currentVersion} — no newer release available.`
                          : "No newer release available.",
                      });
                    } else if (next.phase === "available" && next.update) {
                      pushToast({
                        level: "info",
                        title: `Octopush ${next.update.version} is ready`,
                        body: "Use the toast in the corner or Settings → About to install.",
                      });
                    } else if (next.phase === "error" && next.error) {
                      pushToast({
                        level: "error",
                        title: "Update check failed",
                        body: next.error,
                      });
                    }
                  })
                }
              />
              <Item
                glyph="i"
                label="What's new"
                detail="this version"
                onSelect={() => run(openWhatsNewForCurrentVersion)}
              />
              {import.meta.env.DEV && (
                <Item
                  glyph="i"
                  label="Preview unreleased tips"
                  detail="dev"
                  onSelect={() => run(previewUnreleasedTips)}
                />
              )}
              <Item
                glyph="&"
                label="Open Settings · Usage"
                shortcut="⌘⇧T"
                onSelect={() => run(onToggleTokens)}
              />
              {activeSession && (
                <Item
                  glyph="◷"
                  label="Set token budget"
                  onSelect={() =>
                    run(async () => {
                      const input = prompt("Token budget (e.g. 100000):");
                      if (input) {
                        const budget = parseInt(input.replace(/[^0-9]/g, ""), 10);
                        if (!isNaN(budget) && activeId) {
                          await ipc.setTokenBudget(activeId, budget);
                          await refresh();
                        }
                      }
                    })
                  }
                />
              )}
              {activeSession && (
                <>
                  <Item
                    glyph="↓"
                    label="Export session (JSON)"
                    onSelect={() =>
                      run(async () => {
                        const json = await ipc.exportSessionJson(activeSession.id);
                        downloadFile(`${activeSession.name}.json`, json, "application/json");
                      })
                    }
                  />
                  <Item
                    glyph="↓"
                    label="Export session (CSV)"
                    onSelect={() =>
                      run(async () => {
                        const csv = await ipc.exportSessionCsv(activeSession.id);
                        downloadFile(`${activeSession.name}.csv`, csv, "text/csv");
                      })
                    }
                  />
                </>
              )}
            </Group>

            {/* Editor */}
            <Group heading="Editor">
              <Item
                glyph="¶"
                label={`Toggle word wrap — ${editorWrap ? "on" : "off"}`}
                onSelect={() => run(() => useEditorPrefs.getState().toggleWrap())}
              />
              <Item
                glyph="+"
                label="Increase font size"
                detail={`${editorFontSize}px`}
                onSelect={() => run(() => useEditorPrefs.getState().bumpFontSize(1))}
              />
              <Item
                glyph="−"
                label="Decrease font size"
                detail={`${editorFontSize}px`}
                onSelect={() => run(() => useEditorPrefs.getState().bumpFontSize(-1))}
              />
              <Item
                glyph="⌶"
                label={`Cycle tab width — ${editorTabWidth} spaces`}
                onSelect={() => run(() => useEditorPrefs.getState().cycleTabWidth())}
              />
              <Item
                glyph="#"
                label={`Toggle line numbers — ${editorLineNumbers ? "on" : "off"}`}
                onSelect={() => run(() => useEditorPrefs.getState().toggleLineNumbers())}
              />
              <Item
                glyph="@"
                label={`Toggle blame — ${blameOn ? "on" : "off"}`}
                onSelect={() => run(() => useBlameStore.getState().toggle())}
              />
            </Group>

            {/* Themes */}
            {themes.length > 0 && (
              <Group heading="Themes">
                {themes.map((t) => (
                  <Item
                    key={t.name}
                    glyph="◐"
                    label={`Theme: ${t.name}`}
                    detail={t.accent}
                    onSelect={() => run(() => applyTheme(t))}
                  />
                ))}
              </Group>
            )}
          </Command.List>
        </Command>
      </div>
    </ModalShell>
  );
}

function Group({
  heading,
  tour,
  children,
}: {
  heading: string;
  tour?: string;
  children: React.ReactNode;
}) {
  return (
    <Command.Group
      heading={heading}
      data-tour={tour}
      className="px-1 pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[8px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.3em] [&_[cmdk-group-heading]]:text-octo-brass"
    >
      {children}
    </Command.Group>
  );
}

/** Select a mounted row the way cmdk selects one under the pointer, so cmdk
 *  updates its own value, aria-selected and aria-activedescendant together
 *  (#897), then bring the row into view as keyboard navigation would. */
function selectRow(list: HTMLElement | null, value: string) {
  const row = Array.from(list?.querySelectorAll<HTMLElement>("[cmdk-item]") ?? []).find(
    (el) => el.dataset.paletteValue === value,
  );
  if (!row) return;
  row.dispatchEvent(new Event("pointermove", { bubbles: true }));
  row.scrollIntoView?.({ block: "nearest" });
}

function Item({
  glyph,
  label,
  detail,
  shortcut,
  tour,
  value,
  keywords,
  onSelect,
}: {
  value?: string;
  keywords?: string[];
  glyph: string;
  label: string;
  detail?: string;
  shortcut?: string;
  tour?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      data-tour={tour}
      data-palette-value={value}
      className="group mx-1 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] text-octo-sage aria-selected:text-octo-ivory"
      style={
        {
          // Tailwind aria-selected variant doesn't reach inline style; use a CSS variable
          // here so the rule below can pick it up via `aria-selected="true"` attribute.
        }
      }
    >
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded font-serif text-[12px] text-octo-mute group-aria-selected:text-octo-brass"
        style={{
          border: "1px solid var(--color-octo-hairline)",
        }}
      >
        {glyph}
      </span>
      {/* The label is what tells rows apart, so the detail gives way first
          (shrink-[100] against the label's content-sized basis); both ellipsize
          and keep their full text in a title. */}
      <span className="min-w-0 flex-auto truncate" title={label}>{label}</span>
      {detail && (
        <span
          className="min-w-0 shrink-[100] truncate font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute"
          title={detail}
        >
          {detail}
        </span>
      )}
      {shortcut && (
        <kbd className="shrink-0 rounded border border-octo-hairline bg-octo-onyx px-1.5 py-0.5 font-mono text-[9px] tracking-[0.05em] text-octo-mute">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}

/** A Groups row: the group's own mark (the rail's chevron, in its tint) in
 *  the glyph box, its name over a mono meta line (`acme-api · 3 missions`
 *  for a mission group, `2 projects` for a project group). */
function GroupItem({ row, onSelect }: { row: PaletteGroup; onSelect: () => void }) {
  const kind = row.scope === "project" ? "Project group" : "Mission group";
  return (
    <Command.Item
      value={`${GROUP_VALUE_PREFIX}${row.id}`}
      keywords={row.keywords}
      onSelect={onSelect}
      data-testid="palette-group"
      className="group mx-1 flex cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 text-[13px] text-octo-sage aria-selected:text-octo-ivory"
    >
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-octo-hairline"
        style={{ color: groupMarkColor(row, "var(--color-octo-mute)") }}
      >
        <ChevronDown size={12} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0" title={`${kind}: ${row.name}`}>
          <MidTruncate text={row.name} className="min-w-0 flex-1" />
        </span>
        <span className="flex min-w-0 font-mono text-[10px] text-octo-mute" title={row.meta}>
          <MidTruncate text={row.meta} tail={16} className="min-w-0 flex-1" />
        </span>
      </span>
    </Command.Item>
  );
}

/** A Workspaces row: the name over a mono meta line, "<project> · <branch>"
 *  ("<project> · <group> · <branch>" for a mission in a group), both
 *  middle-truncated like the rail with the full text in a title. A
 *  static dot says the crew needs you (brass, the rail's non-beacon dot) or
 *  that it is working (sage); the palette never pulses. */
function WorkspaceItem({ row, onSelect }: { row: PaletteWorkspace; onSelect: () => void }) {
  // Outermost first, as the slim rail's flyout reads: project · group · branch.
  const meta = [row.project, row.group, row.branch].filter(Boolean).join(" · ");
  const state = row.needsYou ? "Needs you" : row.running ? "Working" : null;
  return (
    <Command.Item
      // cmdk keys selection on `value`: the id keeps two same-named rows
      // (one `main` per project) distinct; name, branch and project match
      // through `keywords`. The prefix tells `paletteFilter` to score the
      // keywords alone, so the UUID never matches a search.
      value={`${WORKSPACE_VALUE_PREFIX}${row.id}`}
      keywords={row.keywords}
      onSelect={onSelect}
      data-testid="palette-workspace"
      className="group mx-1 flex cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 text-[13px] text-octo-sage aria-selected:text-octo-ivory"
    >
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-octo-hairline font-serif text-[12px] text-octo-mute group-aria-selected:text-octo-brass"
      >
        {row.glyph}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0" title={row.name}>
          <MidTruncate text={row.name} className="min-w-0 flex-1" />
        </span>
        <span className="flex min-w-0 font-mono text-[10px] text-octo-mute" title={meta}>
          <MidTruncate text={meta} tail={16} className="min-w-0 flex-1" />
        </span>
      </span>
      {/* Reserved slot, so a state change never shifts the row. */}
      <span className="flex w-2 shrink-0 justify-center">
        {state && (
          <span
            role="img"
            aria-label={state}
            title={state}
            data-testid="palette-workspace-state"
            className={`octo-pop-in h-[5px] w-[5px] rounded-full ${row.needsYou ? "bg-octo-brass" : "bg-octo-sage"}`}
          />
        )}
      </span>
    </Command.Item>
  );
}

// CSS for aria-selected highlight (overrides Tailwind ordering and applies a
// brass-ghost background to the currently focused item).
const _styleInject = `
[cmdk-item][aria-selected="true"] {
  background: var(--brass-ghost);
}
[cmdk-item][aria-selected="true"] > span:first-child {
  border-color: var(--brass-dim);
}
`;
if (typeof document !== "undefined" && !document.getElementById("cmdk-brass-styles")) {
  const el = document.createElement("style");
  el.id = "cmdk-brass-styles";
  el.textContent = _styleInject;
  document.head.appendChild(el);
}

function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
