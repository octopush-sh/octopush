# Rail collapse motion — premium expand/collapse — Plan 11

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make per-project expand/collapse (and the Recently-closed drawer) animate smoothly instead of snapping, matching the app's established motion language.

**Architecture:** Reuse the app's own collapse idiom from `WorkContextPanel` (companion): a CSS **grid with `grid-template-rows` animated `0fr ↔ 1fr`** plus opacity, `overflow-hidden`, `transition-all duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]` (same 280ms `--ease-octo` as the ModeSwitcher glide and the Jira pills). The collapsible content is always rendered (clipped when collapsed) so height can animate. The chevrons already rotate at 280ms — this adds the matching body growth.

**Tech Stack:** React 19 + TS, Tailwind tokens. No new deps.

**Reference:** `src/components/WorkContextPanel.tsx:255-266` (the exact grid-rows pattern).

---

## Task 1: Animate per-project workspace list (SortableProjectGroup)

**Files:** Modify `src/components/WorkspaceRail.tsx` (`SortableProjectGroup`, the workspaces region ~lines 360-391).

- [ ] **Step 1: wrap the workspaces + empty state in an animated grid region**

Current (read it; approx.):
```tsx
            {(isCollapsed || projectExpanded) &&
              visibleWs.map((ws) => (
                <WorkspaceRow ... />
              ))}

            {!isCollapsed &&
              projectExpanded &&
              visibleWs.length === 0 && (
                <div className="px-3 py-1.5 font-mono text-[10px] tracking-[0.15em] text-octo-mute">
                  No workspaces yet
                </div>
              )}
```

Replace BOTH blocks with a single always-rendered, height-animated region (the content is clipped when collapsed so it can animate). `shown = isCollapsed || projectExpanded`:
```tsx
            {/* Workspaces — premium collapse: grid-rows 0fr↔1fr + opacity,
                the same idiom as WorkContextPanel / ModeSwitcher (280ms ease). */}
            <div
              aria-hidden={!isCollapsed && !projectExpanded}
              className="grid overflow-hidden transition-all duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
              style={{
                gridTemplateColumns: "minmax(0, 1fr)",
                gridTemplateRows: isCollapsed || projectExpanded ? "1fr" : "0fr",
                opacity: isCollapsed || projectExpanded ? 1 : 0,
              }}
            >
              <div className="flex min-h-0 flex-col gap-1 overflow-hidden">
                {visibleWs.map((ws) => (
                  <WorkspaceRow ...ALL existing props unchanged... />
                ))}
                {!isCollapsed && visibleWs.length === 0 && (
                  <div className="px-3 py-1.5 font-mono text-[10px] tracking-[0.15em] text-octo-mute">
                    No workspaces yet
                  </div>
                )}
              </div>
            </div>
```
Keep every existing `<WorkspaceRow>` prop EXACTLY (key, workspace, active, isCollapsed, ticketKey, dirty, ahead, behind, hasOpenPr, onSelect, onCustomize, onContextMenu). The empty-state condition drops `projectExpanded` (the grid clipping handles collapse) but keeps `!isCollapsed` (no "No workspaces yet" text in icon mode).

Notes:
- In icon-collapsed rail mode (`isCollapsed`), `shown` is always true → rows always visible (monograms), no animation — unchanged behavior.
- When the per-project chevron toggles `collapsedProjects[project.id]` (expanded-rail mode), `projectExpanded` flips and the region animates 1fr↔0fr.
- Filter (`q !== ""`) forces `projectExpanded = true` → region open.

- [ ] **Step 2: verify**

Run `npm run typecheck` → clean. `npm test` → green. The WorkspaceRail tests render projects expanded (no `collapsedProjects` set) so rows still render; confirm counts unchanged. If a test asserted rows are ABSENT for a collapsed project (DOM removal), it must change to assert the region is collapsed (rows are now present-but-clipped) — note any such change. `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.

- [ ] **Step 3: commit**
```bash
git add src/components/WorkspaceRail.tsx
git commit -m "feat(rail): animate per-project expand/collapse (grid-rows, 280ms ease-octo)"
```

---

## Task 2: Animate the Recently-closed drawer body

**Files:** Modify `src/components/RecentlyClosedDrawer.tsx`.

- [ ] **Step 1: replace the conditional list with an animated grid region**

Current:
```tsx
      {open && (
        <div id="recently-closed-panel" className="mt-1 flex flex-col">
          {projects.map((p) => ( ...entry... ))}
        </div>
      )}
```
Replace with (always rendered, height-animated; chevron already rotates):
```tsx
      <div
        id="recently-closed-panel"
        aria-hidden={!open}
        className="grid overflow-hidden transition-all duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
        }}
      >
        <div className="mt-1 flex min-h-0 flex-col overflow-hidden">
          {projects.map((p) => ( ...EXISTING entry JSX unchanged... ))}
        </div>
      </div>
```
Keep each entry's JSX (ProjectMark, name span, Restore button with its focus-visible classes) exactly as-is.

- [ ] **Step 2: verify + commit**

Run `npm run typecheck` → clean. `npm test` → green. `git diff -- src | grep -nE "#[0-9a-fA-F]{3,8}"` → empty.
```bash
git add src/components/RecentlyClosedDrawer.tsx
git commit -m "feat(rail): animate Recently-closed drawer open/close (grid-rows)"
```

---

## Task 3: Verification + rebuild

- [ ] `npm run typecheck && npm test` — green.
- [ ] Manual: collapsing/expanding a project glides the workspaces (height + fade, 280ms) in sync with the chevron rotation; the Recently-closed drawer glides open/close. No snap. Icon-collapsed rail unchanged. Drag-reorder still smooth.
- [ ] Rebuild the `.app` (wipe `bundle/`+`dist/`, touch `lib.rs`, `npm run tauri:build`).

---

## Self-Review (during planning)

- **On-brand:** reuses the exact `WorkContextPanel` grid-rows idiom (280ms `--ease-octo`), so the rail collapse reads as the same family as ModeSwitcher/Jira-pills — premium, calm, no spring.
- **Behavior preserved:** content always rendered (clipped) so it can animate; icon-collapsed mode and filter-forced-expand unchanged; all WorkspaceRow props intact; `aria-hidden` reflects collapsed state (mirrors WorkContextPanel).
- **Cost:** collapsed projects/drawer now keep their rows in the DOM (clipped). Negligible for typical workspace/closed counts; the heavy git/PR work is unaffected (still data-driven, not per-row-mount).
