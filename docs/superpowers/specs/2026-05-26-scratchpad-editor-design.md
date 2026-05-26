# Scratchpad Editor — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans (recommended) or superpowers:executing-plans to implement this spec task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-accessible temporary code/text editor for quick formatting and manipulation without creating files. Users can paste content, format it with syntax highlighting, and copy it elsewhere without workspace pollution.

**Architecture:** The Scratchpad is an optional split panel on the right side of the Canvas. When activated via toolbar icon, the Canvas divides vertically (50/50 default, draggable). The Scratchpad maintains multiple tabs with auto-detected syntax highlighting. Content persists for the session (survives workspace/project switches, lost on app close).

**Tech Stack:** React 19, TypeScript, Zustand (in-memory state), highlight.js or prism.js (syntax highlighting), Tailwind v4 (styling with Atelier tokens).

---

## Feature Overview

### User Workflows

**Workflow 1: Quick Formatting**
1. Claude Code outputs a curl command
2. User clicks Scratchpad icon (ContextHeader toolbar)
3. Canvas splits, Scratchpad opens with empty "Untitled 1" tab
4. User pastes curl command
5. Syntax highlighting auto-detects shell syntax (or JSON, JavaScript, etc.)
6. User reformats/edits as needed
7. User copies the result, pastes elsewhere
8. Closes Scratchpad (content stays in session if reopened later)

**Workflow 2: Multiple Tab Management**
1. User has curl in "Untitled 1"
2. Clicks "+" to create new tab → "Untitled 2" appears
3. Double-clicks "Untitled 2" to rename → types "json-payload.json"
4. Language auto-detects as JSON from `.json` extension
5. Pastes JSON, formats it
6. Switches back to "Untitled 1" (curl is still there)
7. Closes tab "Untitled 2" → only "Untitled 1" remains
8. Closes Scratchpad, reopens later → both tabs still there (session persisted)

**Workflow 3: Cross-Workspace Persistence**
1. User in Workspace A with Scratchpad open, content visible
2. Switches to Workspace B
3. Scratchpad content is still there (same tabs, same text)
4. Switches back to Workspace A → content unchanged

---

## UI/UX Details

### ContextHeader Toolbar Icon

**Location:** Right side of ContextHeader, next to or integrated with ModeSwitcher group (Talk · Run · Review).

**Icon Design:**
- Glyph: `≡` (three horizontal lines, represents editor/document) or equivalent
- Inactive state: brass at 20% opacity (muted)
- Active state: brass full brightness
- Hover: transitions to full brightness, subtle scale or color shift
- Tooltip (italic serif, brass): "Open scratchpad" (inactive) / "Close scratchpad" (active)

**Interaction:**
- Click toggles Scratchpad open/closed
- No modal — splits the Canvas in-place
- Visual feedback: icon highlighted in brass when active

### Split Layout

**Default Layout:**
- Canvas is 100% width
- When Scratchpad activated: Canvas divides into two columns
  - Left column: existing Canvas content (TALK/RUN/REVIEW modes) — ~50% width by default
  - Right column: Scratchpad editor — ~50% width by default
  - Divider: thin `octo-hairline` border, interactive (draggable)

**Divider (Resizer):**
- Cursor changes to `col-resize` on hover
- Drag to adjust split ratio (e.g., 70/30, 40/60)
- Ratio stored in local state (not persisted; resets on close/open)
- Hover state: divider turns `octo-brass` for visual feedback
- Motion: smooth, no lag

**Closing:**
- Click Scratchpad icon again → split collapses, Canvas returns to 100% width
- Content is **not lost** — remains in session state for re-opening

---

## Scratchpad Editor Component

### Tabs Bar

**Layout:**
- Horizontal bar at top of Scratchpad panel
- Background: `octo-onyx` (darker than panel)
- Border-top: `octo-hairline`
- Left-to-right: [Tab 1] [Tab 2] [Tab N] [+ button]

**Individual Tab Styling:**
- Active tab:
  - Background: `octo-panel` (lighter, distinguishable)
  - Border-bottom: 2px `octo-brass` (indicator line)
  - Text: `octo-ivory`
  - Cursor: pointer
- Inactive tab:
  - Background: `octo-onyx`
  - Text: `octo-mute`
  - Hover: text → `octo-sage`, slight background shift
- Font: mono, 11px (consistent with editor tabs in REVIEW mode)
- Padding: compact (8px horizontal, 4px vertical)

**Tab Name Display:**
- Shows: `Untitled 1`, `curl-command.sh`, `data.json`, etc.
- Language badge (optional, subtle): small text next to name showing detected language (e.g., "shell", "json") in `octo-mute`, 8px

**Tab Interactions:**
- Click to switch tabs
- Double-click to rename (see below)
- Hover shows "×" close button (trash/X icon, 12px, brass on hover)
- Click "×" deletes tab (if last tab is deleted, Scratchpad closes)

**"+" Button (New Tab):**
- Right-aligned in tabs bar
- Icon: `+` in brass (dim by default, bright on hover)
- Click: creates new tab named `Untitled N` (where N is next number)
- Automatically switches to new tab

### Rename Interaction

**Trigger:** Double-click on any tab name

**Visual State:**
- Tab name becomes an inline `<input>` element
- Background: slightly darker, border: 1px `octo-brass`
- Focus: cursor visible, text selected
- Font: same as tab name (mono, 11px)

**Behavior:**
- Press Enter → confirm, close input, update store
- Click outside → confirm silently
- Press Escape → cancel, revert to original name
- On blur/enter, parse the name for file extension:
  - `.json` → language = "json"
  - `.sh` → language = "shell"
  - `.js` → language = "javascript"
  - `.py` → language = "python"
  - `.ts` → language = "typescript"
  - `.xml` → language = "xml"
  - `.html` → language = "html"
  - `.css` → language = "css"
  - `.sql` → language = "sql"
  - `.go` → language = "go"
  - No extension or unknown → language = "plaintext"

**Validation:**
- Disallow empty names (revert to original if user tries)
- Disallow duplicates (append number if collision, e.g., "data.json" → "data1.json")

### Editor Area

**Container:**
- Background: `octo-onyx`
- Border: none (seamless with background)
- Padding: 0 (editor fills available space)
- Height: fill remaining space below tabs bar

**Editor Features:**
- Monospace font: JetBrains Mono, 12px
- Text color: `octo-ivory`
- Line numbers: enabled (subtle, `octo-mute`)
- Word wrap: enabled
- Tab size: 2 spaces (or user preference)
- Syntax highlighting: enabled, auto-detected by language
- Theme: custom theme matching Atelier (onyx background, warm accent colors for syntax)

**Syntax Highlighting Library:**
- Use `highlight.js` or `prism.js`
- Theme: custom Atelier-compatible theme with:
  - Keywords: brass or warm accent
  - Strings: soft green (`octo-verdigris`)
  - Numbers: brass or gold
  - Comments: muted (`octo-mute`)
  - Functions: brass or similar
  - All colors respect design system tokens

**Copy/Paste:**
- Standard browser behavior (Ctrl+C, Cmd+C, Ctrl+V, Cmd+V)
- No special handling — just a text editor

**Placeholder (empty tab):**
- Text: "Paste code here, or start typing…" (italic serif, brass, centered, 14px)
- Disappears on first keystroke/paste

---

## State Management

### Zustand Store: `useScratchpadStore`

**Location:** `src/stores/scratchpadStore.ts`

**State Shape:**
```typescript
interface ScratchpadTab {
  id: string;              // UUID, unique per tab
  name: string;            // "Untitled 1", "curl.sh", "data.json"
  content: string;         // full text content
  language: string;        // "json", "shell", "javascript", "plaintext", etc.
}

interface ScratchpadState {
  isOpen: boolean;
  tabs: ScratchpadTab[];
  activeTabId: string | null;
  
  // Actions
  toggleOpen: () => void;
  createTab: () => void;
  deleteTab: (tabId: string) => void;
  renameTab: (tabId: string, newName: string) => void;
  setContent: (tabId: string, content: string) => void;
  setActiveTab: (tabId: string) => void;
  detectLanguageFromName: (name: string) => string; // helper
}
```

**Persistence:**
- **During session:** All state lives in Zustand (in-memory, not persisted to localStorage or disk)
- **On app close:** All content is lost (intentional — scratchpad is temporary)
- **On workspace/project switch:** State is retained (survives navigation)
- **On page reload:** All content is lost

**Initialization:**
- On app mount: `isOpen = false`, `tabs = []`, `activeTabId = null`
- Store is always accessible, even when Scratchpad is closed

### Local Component State: `CanvasSplit`

**Purpose:** Track the split ratio (position of divider)

**State:**
```typescript
const [splitRatio, setSplitRatio] = useState(50); // 0-100, percent for left column
```

**Behavior:**
- Initial: 50 (equal split)
- User drags divider: updates in real-time
- When Scratchpad closes: ratio reset to 50 on next open
- Not persisted (local component state only)

---

## Component Structure

### New Components

#### 1. `ScratchpadIcon` (in ContextHeader)
- Props: `{ isOpen: boolean; onClick: () => void }`
- Renders: brass icon in toolbar
- Tooltip management: uses existing Octopush tooltip system

#### 2. `CanvasSplit` (wrapper around Canvas)
- Props: `{ children: ReactNode; scratchpadIsOpen: boolean }`
- Manages: two-column layout, divider position, resize logic
- Renders: left column (children), divider, right column (Scratchpad)
- Stores: local `splitRatio` state

#### 3. `ScratchpadEditor` (main editor panel)
- Props: none (consumes from Zustand store)
- Renders: tabs bar + editor area
- Children:
  - `ScratchpadTabsBar` (manages tabs UI and interactions)
  - `ScratchpadCodeEditor` (Monaco or CodeMirror instance)

#### 4. `ScratchpadTabsBar`
- Props: none (Zustand state)
- Renders: horizontal bar with tabs and "+" button
- Handles: tab click, rename, delete, create

#### 5. `ScratchpadTab` (individual tab)
- Props: `{ tab: ScratchpadTab; isActive: boolean; onSelect: () => void; onDelete: () => void; onRename: (newName: string) => void }`
- Renders: single tab with interactions

#### 6. `ScratchpadCodeEditor` (editor instance)
- Props: none (Zustand state)
- Uses: `react-simple-code-editor` or Monaco or CodeMirror
- Renders: editor with syntax highlighting

### Integration Points

1. **App.tsx:** 
   - Conditionally wrap Canvas with `CanvasSplit` when Scratchpad is available
   - Pass `scratchpadIsOpen` to `CanvasSplit`
   - Render `ScratchpadIcon` in ContextHeader toolbar

2. **ContextHeader.tsx:**
   - Add `onScratchpadToggle` prop
   - Render `ScratchpadIcon` in rightSlot or new toolbar area

---

## Language Detection

### Extension-to-Language Mapping

```typescript
const LANGUAGE_MAP: Record<string, string> = {
  // No extension
  "": "plaintext",
  
  // Languages
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".json": "json",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".ps1": "powershell",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cpp": "cpp",
  ".c": "c",
  ".h": "c",
  ".cs": "csharp",
  ".php": "php",
  ".sql": "sql",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".txt": "plaintext",
};
```

**Logic:**
- Extract file extension from tab name (last `.` onward)
- Look up in map
- If not found → "plaintext"
- Update store's `language` field
- Pass to syntax highlighter

---

## Design System Integration (Atelier in Onyx & Brass)

### Colors (CSS Variables)

- **Background:** `var(--color-octo-onyx)` (darkest, code editor)
- **Panel:** `var(--color-octo-panel)` (tabs bar)
- **Text:** `var(--color-octo-ivory)` (main, active)
- **Mute:** `var(--color-octo-mute)` (inactive, secondary)
- **Accent:** `var(--color-octo-brass)` (focus, active states, syntax highlighting)
- **Secondary Accent:** `var(--color-octo-verdigris)` (syntax highlighting)
- **Hairline:** `var(--color-octo-hairline)` (borders, dividers)

### Typography

- **Tabs:** JetBrains Mono, 11px, uppercase tracking for labels
- **Editor:** JetBrains Mono, 12px, line-height 1.5
- **Placeholder/hints:** Spectral Italic, 14px, brass, centered

### Motion

- **Split opening:** fade-in 220ms, `cubic-bezier(0.2, 0.8, 0.3, 1)`
- **Split closing:** fade-out 220ms, same easing
- **Divider drag:** instant response, smooth (no easing needed for real-time)
- **Tab switch:** instant (no animation)
- **Rename input:** no animation, just state change

### Spacing

- **Tabs bar height:** 40px (consistent with Canvas tabs)
- **Tab padding:** 8px horizontal, 4px vertical
- **Editor padding:** 0 (fills available space)
- **Divider width:** 1px
- **Overall margins:** respect `m-4` spacing from Canvas

---

## Error Handling & Edge Cases

**Empty tab name on rename:**
- User clears name completely
- System reverts to original name on blur/enter
- No error message (silent revert)

**Duplicate tab names:**
- User renames Tab 1 to "data.json", then Tab 2 to "data.json"
- System renames second to "data1.json" automatically
- No error modal, just happens

**Tab overflow (many tabs):**
- If tabs bar overflows horizontally: enable horizontal scroll
- Or truncate tab names and show full name in tooltip

**Very large content:**
- No size limit enforced (browser memory is the limit)
- Large pastes should work fine (editor libraries handle this)

**Language detection failure:**
- Unknown extension defaults to "plaintext"
- User can't manually override (by design, keep simple)

**Closing last tab:**
- When user clicks "×" on the last remaining tab
- Scratchpad automatically closes
- Content is preserved in store (if reopened immediately)

---

## Testing Strategy

### Unit Tests (`vitest`)

**Store (`useScratchpadStore`):**
- `test: createTab increments Untitled number`
- `test: deleteTab removes from array and updates activeTab`
- `test: renameTab updates name and detects language from extension`
- `test: setContent updates correct tab's content`
- `test: setActiveTab validates tabId exists`
- `test: detectLanguageFromName returns correct language`

**Language Detection:**
- `test: .json extension → "json"`
- `test: .sh extension → "shell"`
- `test: no extension → "plaintext"`
- `test: unknown extension → "plaintext"`

### Integration Tests

**Render tests:**
- `test: Scratchpad renders tabs bar and editor on open`
- `test: clicking + button creates new tab`
- `test: double-clicking tab name makes it editable`
- `test: pressing Enter on rename updates store`
- `test: clicking × closes tab`
- `test: content persists when switching tabs`

**Layout tests:**
- `test: Canvas splits 50/50 on Scratchpad open`
- `test: divider drag updates split ratio`
- `test: closing Scratchpad returns Canvas to 100% width`

**Session persistence:**
- `test: switching workspace keeps Scratchpad content`
- `test: closing and reopening Scratchpad keeps content`
- `test: closing app loses content (localStorage empty)`

### Manual Testing (E2E)

1. Paste a curl command, verify syntax highlighting
2. Rename tab to "curl.sh", verify language changes
3. Create multiple tabs, switch between them
4. Drag divider, verify responsive layout
5. Close Scratchpad, reopen, verify content still there
6. Switch workspace, verify Scratchpad content persists
7. Close app and reopen, verify content is gone

---

## Accessibility

- **Icon tooltip:** included for clarity
- **Tab selection:** keyboard navigation (Tab key moves between tabs)
- **Editor:** standard browser accessibility (can be selected, focused, copied)
- **Focus indicators:** brass border on active tab, standard for input
- **ARIA labels:** Scratchpad as a region, tabs as tab list

---

## Future Enhancements (Out of Scope)

- Syntax highlighting color scheme customization
- Save to file (download as .txt, .json, etc.)
- Language selector dropdown (if auto-detection fails)
- Undo/redo (rely on browser's CodeMirror/Monaco)
- Search/replace in Scratchpad
- Sharing (copy URL with encoded content)
- Multi-editor view (side-by-side tabs)

---

## Files to Create/Modify

**New Files:**
- `src/stores/scratchpadStore.ts` — Zustand store
- `src/components/ScratchpadEditor.tsx` — main component
- `src/components/ScratchpadTabsBar.tsx` — tabs UI
- `src/components/ScratchpadTab.tsx` — individual tab
- `src/components/ScratchpadCodeEditor.tsx` — editor instance
- `src/components/ScratchpadIcon.tsx` — toolbar icon
- `src/components/CanvasSplit.tsx` — layout wrapper

**Modified Files:**
- `src/App.tsx` — integrate Scratchpad, wrap Canvas with CanvasSplit
- `src/components/ContextHeader.tsx` — add ScratchpadIcon to toolbar
- `src/components/ReviewCanvas.tsx` or parent — adjust layout for split

---

## Success Criteria

✅ User can open/close Scratchpad from toolbar icon  
✅ Content supports multiple tabs with auto-detected syntax highlighting  
✅ Split is draggable and responsive  
✅ Content persists across workspace switches during session  
✅ Content is lost on app close (intentional)  
✅ Renaming tabs updates language detection  
✅ UI integrates seamlessly with Atelier design system  
✅ No persisted files or workspace pollution  
✅ Tests cover store logic, rendering, and persistence  

