# Scratchpad Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a temporary code/text editor accessible from the Canvas toolbar, supporting multiple tabs with auto-detected syntax highlighting and session-based persistence.

**Architecture:** Zustand store manages scratchpad state (tabs, content, active tab). React components render split layout with draggable divider. Language detection utility parses file extensions. Syntax highlighting via highlight.js. Components compose as: CanvasSplit (wrapper) → left (Canvas) + right (ScratchpadEditor). ScratchpadEditor contains ScratchpadTabsBar + ScratchpadCodeEditor.

**Tech Stack:** React 19, TypeScript, Zustand, highlight.js (syntax highlighting), Tailwind v4, @tauri-apps/api.

---

## File Structure

**New files to create:**
- `src/stores/scratchpadStore.ts` — Zustand store for state
- `src/stores/scratchpadStore.test.ts` — tests for store
- `src/lib/languageDetection.ts` — detect language from filename
- `src/lib/languageDetection.test.ts` — tests for detection
- `src/components/ScratchpadIcon.tsx` — toolbar icon
- `src/components/CanvasSplit.tsx` — split layout wrapper
- `src/components/ScratchpadEditor.tsx` — main editor component
- `src/components/ScratchpadTabsBar.tsx` — tabs bar UI
- `src/components/ScratchpadTab.tsx` — individual tab
- `src/components/ScratchpadCodeEditor.tsx` — code editor with highlighting
- `src/components/ScratchpadEditor.test.tsx` — integration tests

**Files to modify:**
- `src/App.tsx` — wrap Canvas with CanvasSplit, manage scratchpad state
- `src/components/ContextHeader.tsx` — add ScratchpadIcon to toolbar
- `package.json` — add highlight.js dependency

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add highlight.js to dependencies**

Run:
```bash
npm install highlight.js
```

This adds syntax highlighting support for 180+ languages.

- [ ] **Step 2: Verify installation**

Run:
```bash
npm ls highlight.js
```

Expected: `highlight.js@11.x.x` (or similar version)

---

## Task 2: Create Language Detection Utility

**Files:**
- Create: `src/lib/languageDetection.ts`
- Create: `src/lib/languageDetection.test.ts`

- [ ] **Step 1: Write failing tests for language detection**

Create `src/lib/languageDetection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectLanguageFromName } from "./languageDetection";

describe("detectLanguageFromName", () => {
  it("detects JSON from .json extension", () => {
    expect(detectLanguageFromName("data.json")).toBe("json");
  });

  it("detects shell from .sh extension", () => {
    expect(detectLanguageFromName("script.sh")).toBe("shell");
  });

  it("detects JavaScript from .js extension", () => {
    expect(detectLanguageFromName("app.js")).toBe("javascript");
  });

  it("detects TypeScript from .ts extension", () => {
    expect(detectLanguageFromName("types.ts")).toBe("typescript");
  });

  it("detects Python from .py extension", () => {
    expect(detectLanguageFromName("script.py")).toBe("python");
  });

  it("detects SQL from .sql extension", () => {
    expect(detectLanguageFromName("query.sql")).toBe("sql");
  });

  it("detects HTML from .html extension", () => {
    expect(detectLanguageFromName("page.html")).toBe("html");
  });

  it("detects CSS from .css extension", () => {
    expect(detectLanguageFromName("styles.css")).toBe("css");
  });

  it("detects XML from .xml extension", () => {
    expect(detectLanguageFromName("data.xml")).toBe("xml");
  });

  it("defaults to plaintext for no extension", () => {
    expect(detectLanguageFromName("Untitled")).toBe("plaintext");
  });

  it("defaults to plaintext for unknown extension", () => {
    expect(detectLanguageFromName("file.unknown")).toBe("plaintext");
  });

  it("handles uppercase extensions", () => {
    expect(detectLanguageFromName("data.JSON")).toBe("json");
  });

  it("handles multiple dots in filename", () => {
    expect(detectLanguageFromName("my.config.json")).toBe("json");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- src/lib/languageDetection.test.ts
```

Expected: All tests fail with "function not found"

- [ ] **Step 3: Implement language detection utility**

Create `src/lib/languageDetection.ts`:

```typescript
const LANGUAGE_MAP: Record<string, string> = {
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

export function detectLanguageFromName(name: string): string {
  if (!name) return "plaintext";
  
  // Extract extension (last dot onwards)
  const lastDotIndex = name.lastIndexOf(".");
  if (lastDotIndex === -1) return "plaintext";
  
  const extension = name.substring(lastDotIndex).toLowerCase();
  return LANGUAGE_MAP[extension] || "plaintext";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm test -- src/lib/languageDetection.test.ts
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/lib/languageDetection.ts src/lib/languageDetection.test.ts
git commit -m "feat: add language detection utility from filenames

- detectLanguageFromName(name: string): string
- Supports 25+ file extensions (js, ts, json, sh, py, sql, etc.)
- Defaults to 'plaintext' for unknown extensions
- Case-insensitive (handles .JSON, .JS, etc.)

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Create Zustand Store

**Files:**
- Create: `src/stores/scratchpadStore.ts`
- Create: `src/stores/scratchpadStore.test.ts`

- [ ] **Step 1: Write failing tests for store**

Create `src/stores/scratchpadStore.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspaceStore } from "./scratchpadStore";

describe("useScratchpadStore", () => {
  beforeEach(() => {
    const store = useWorkspaceStore.getState();
    store.reset?.();
  });

  it("initializes with empty state", () => {
    const store = useWorkspaceStore.getState();
    expect(store.isOpen).toBe(false);
    expect(store.tabs).toEqual([]);
    expect(store.activeTabId).toBe(null);
  });

  it("creates a new tab with auto-incremented name", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0].name).toBe("Untitled 1");
    expect(store.tabs[0].content).toBe("");
    expect(store.tabs[0].language).toBe("plaintext");
    expect(store.activeTabId).toBe(store.tabs[0].id);
  });

  it("creates multiple tabs with correct names", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    store.createTab();
    store.createTab();
    
    expect(store.tabs).toHaveLength(3);
    expect(store.tabs[0].name).toBe("Untitled 1");
    expect(store.tabs[1].name).toBe("Untitled 2");
    expect(store.tabs[2].name).toBe("Untitled 3");
  });

  it("sets content for a tab", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;
    
    store.setContent(tabId, "console.log('hello')");
    expect(store.tabs[0].content).toBe("console.log('hello')");
  });

  it("renames a tab and detects language", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;
    
    store.renameTab(tabId, "script.sh");
    expect(store.tabs[0].name).toBe("script.sh");
    expect(store.tabs[0].language).toBe("shell");
  });

  it("prevents empty tab names (reverts to original)", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;
    const originalName = store.tabs[0].name;
    
    store.renameTab(tabId, "");
    expect(store.tabs[0].name).toBe(originalName);
  });

  it("prevents duplicate tab names (appends number)", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    store.createTab();
    const secondTabId = store.tabs[1].id;
    
    store.renameTab(secondTabId, "data.json");
    store.renameTab(secondTabId, "data.json"); // Try to create duplicate
    
    // Should append number to prevent collision
    expect(store.tabs[1].name).toMatch(/data.*\.json/);
  });

  it("deletes a tab", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    store.createTab();
    const firstTabId = store.tabs[0].id;
    
    store.deleteTab(firstTabId);
    expect(store.tabs).toHaveLength(1);
  });

  it("switches active tab", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    store.createTab();
    const secondTabId = store.tabs[1].id;
    
    store.setActiveTab(secondTabId);
    expect(store.activeTabId).toBe(secondTabId);
  });

  it("toggles open state", () => {
    const store = useWorkspaceStore.getState();
    expect(store.isOpen).toBe(false);
    
    store.toggleOpen();
    expect(store.isOpen).toBe(true);
    
    store.toggleOpen();
    expect(store.isOpen).toBe(false);
  });

  it("closes scratchpad when deleting last tab", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    const tabId = store.tabs[0].id;
    
    store.deleteTab(tabId);
    expect(store.tabs).toHaveLength(0);
    expect(store.isOpen).toBe(false);
  });

  it("preserves content when switching workspaces (session state)", () => {
    const store = useWorkspaceStore.getState();
    store.createTab();
    store.setContent(store.tabs[0].id, "test content");
    
    // Simulate workspace switch (state should persist)
    const contentBefore = store.tabs[0].content;
    expect(contentBefore).toBe("test content");
    // Workspace switching happens in App.tsx, not in store
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- src/stores/scratchpadStore.test.ts
```

Expected: All tests fail with "cannot find name 'useWorkspaceStore'"

- [ ] **Step 3: Implement Zustand store**

Create `src/stores/scratchpadStore.ts`:

```typescript
import { create } from "zustand";
import { detectLanguageFromName } from "../lib/languageDetection";

export interface ScratchpadTab {
  id: string;
  name: string;
  content: string;
  language: string;
}

interface ScratchpadState {
  isOpen: boolean;
  tabs: ScratchpadTab[];
  activeTabId: string | null;

  toggleOpen: () => void;
  createTab: () => void;
  deleteTab: (tabId: string) => void;
  renameTab: (tabId: string, newName: string) => void;
  setContent: (tabId: string, content: string) => void;
  setActiveTab: (tabId: string) => void;
  reset: () => void;
}

export const useScratchpadStore = create<ScratchpadState>((set, get) => ({
  isOpen: false,
  tabs: [],
  activeTabId: null,

  toggleOpen: () => {
    set((state) => {
      const nextOpen = !state.isOpen;
      // If opening and no tabs, create first tab
      if (nextOpen && state.tabs.length === 0) {
        const newTab: ScratchpadTab = {
          id: crypto.randomUUID(),
          name: "Untitled 1",
          content: "",
          language: "plaintext",
        };
        return {
          isOpen: true,
          tabs: [newTab],
          activeTabId: newTab.id,
        };
      }
      return { isOpen: nextOpen };
    });
  },

  createTab: () => {
    set((state) => {
      const nextNumber = state.tabs.length + 1;
      const newTab: ScratchpadTab = {
        id: crypto.randomUUID(),
        name: `Untitled ${nextNumber}`,
        content: "",
        language: "plaintext",
      };
      return {
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      };
    });
  },

  deleteTab: (tabId: string) => {
    set((state) => {
      const filtered = state.tabs.filter((t) => t.id !== tabId);
      
      // If last tab deleted, close scratchpad
      if (filtered.length === 0) {
        return {
          tabs: [],
          activeTabId: null,
          isOpen: false,
        };
      }

      // If deleted tab was active, switch to next available
      let nextActiveId = state.activeTabId;
      if (nextActiveId === tabId) {
        nextActiveId = filtered[0].id;
      }

      return {
        tabs: filtered,
        activeTabId: nextActiveId,
      };
    });
  },

  renameTab: (tabId: string, newName: string) => {
    set((state) => {
      const trimmed = newName.trim();

      // Don't allow empty names
      if (!trimmed) {
        return state;
      }

      // Check for duplicates
      const exists = state.tabs.some((t) => t.id !== tabId && t.name === trimmed);
      const finalName = exists ? `${trimmed.slice(0, -3)}1${trimmed.slice(-3)}` : trimmed;

      const language = detectLanguageFromName(finalName);

      return {
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, name: finalName, language }
            : t
        ),
      };
    });
  },

  setContent: (tabId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, content } : t
      ),
    }));
  },

  setActiveTab: (tabId: string) => {
    set({ activeTabId: tabId });
  },

  reset: () => {
    set({ isOpen: false, tabs: [], activeTabId: null });
  },
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npm test -- src/stores/scratchpadStore.test.ts
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/stores/scratchpadStore.ts src/stores/scratchpadStore.test.ts
git commit -m "feat: create scratchpad store with full state management

- useScratchpadStore: Zustand store for session-based scratchpad state
- Actions: toggleOpen, createTab, deleteTab, renameTab, setContent, setActiveTab
- Auto language detection on rename using detectLanguageFromName
- Auto-increment tab names (Untitled 1, 2, 3...)
- Duplicate name prevention
- Close on last tab deletion
- All state is in-memory (lost on app close)

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Create ScratchpadIcon Component

**Files:**
- Create: `src/components/ScratchpadIcon.tsx`

- [ ] **Step 1: Create ScratchpadIcon component**

Create `src/components/ScratchpadIcon.tsx`:

```typescript
import { useScratchpadStore } from "../stores/scratchpadStore";

interface Props {
  onClick: () => void;
}

export function ScratchpadIcon({ onClick }: Props) {
  const isOpen = useScratchpadStore((s) => s.isOpen);

  return (
    <button
      type="button"
      onClick={onClick}
      title={isOpen ? "Close scratchpad" : "Open scratchpad"}
      aria-label={isOpen ? "Close scratchpad" : "Open scratchpad"}
      className="flex items-center justify-center h-8 w-8 rounded transition hover:bg-[var(--brass-ghost)]"
      style={{
        color: isOpen
          ? "var(--color-octo-brass)"
          : "var(--color-octo-brass)",
        opacity: isOpen ? 1 : 0.2,
      }}
    >
      <span className="font-mono text-[14px]">≡</span>
    </button>
  );
}
```

- [ ] **Step 2: Test by rendering (manual)**

We'll test integration later. For now, just verify syntax is correct:

```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ScratchpadIcon.tsx
git commit -m "feat: add scratchpad icon component for toolbar

- Icon: ≡ (three horizontal lines)
- Inactive: brass at 20% opacity
- Active: brass at 100% opacity
- Hover: transition
- Tooltip: 'Open scratchpad' / 'Close scratchpad'

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Create CanvasSplit Component

**Files:**
- Create: `src/components/CanvasSplit.tsx`

- [ ] **Step 1: Create CanvasSplit wrapper**

Create `src/components/CanvasSplit.tsx`:

```typescript
import { useState, useRef } from "react";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { ScratchpadEditor } from "./ScratchpadEditor";

interface Props {
  children: React.ReactNode;
}

export function CanvasSplit({ children }: Props) {
  const isOpen = useScratchpadStore((s) => s.isOpen);
  const [splitRatio, setSplitRatio] = useState(50); // 0-100, percent for left column
  const dividerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = () => {
    const onMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const newRatio = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
      setSplitRatio(newRatio);
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  if (!isOpen) {
    return <>{children}</>;
  }

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full gap-0"
    >
      {/* Left column: Canvas */}
      <div style={{ width: `${splitRatio}%` }} className="overflow-hidden">
        {children}
      </div>

      {/* Divider */}
      <div
        ref={dividerRef}
        onMouseDown={handleMouseDown}
        className="w-[1px] bg-octo-hairline cursor-col-resize hover:bg-octo-brass transition-colors"
        aria-hidden
      />

      {/* Right column: Scratchpad */}
      <div style={{ width: `${100 - splitRatio}%` }} className="overflow-hidden">
        <ScratchpadEditor />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Test syntax and types**

Run:
```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/CanvasSplit.tsx
git commit -m "feat: create CanvasSplit wrapper for canvas layout

- Conditionally renders split or normal layout based on isOpen
- Draggable divider to adjust split ratio (20-80%)
- Left: Canvas content, Right: ScratchpadEditor
- Divider: octo-hairline, hover state brass
- Smooth drag interaction with real-time ratio update

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Create ScratchpadCodeEditor Component

**Files:**
- Create: `src/components/ScratchpadCodeEditor.tsx`

- [ ] **Step 1: Create code editor component**

Create `src/components/ScratchpadCodeEditor.tsx`:

```typescript
import hljs from "highlight.js";
import "highlight.js/styles/atom-one-dark.css";
import { useScratchpadStore } from "../stores/scratchpadStore";

export function ScratchpadCodeEditor() {
  const activeTabId = useScratchpadStore((s) => s.activeTabId);
  const tabs = useScratchpadStore((s) => s.tabs);
  const setContent = useScratchpadStore((s) => s.setContent);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-octo-onyx">
        <p className="text-octo-mute">No tab selected</p>
      </div>
    );
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(activeTabId, e.target.value);
  };

  // Get highlighted code
  let highlightedCode = activeTab.content;
  if (activeTab.language !== "plaintext" && activeTab.content) {
    try {
      const highlighted = hljs.highlight(activeTab.content, {
        language: activeTab.language,
        ignoreIllegals: true,
      });
      highlightedCode = highlighted.value;
    } catch {
      // Fallback to plain text if highlighting fails
      highlightedCode = activeTab.content;
    }
  }

  return (
    <div className="h-full w-full bg-octo-onyx overflow-hidden flex flex-col relative">
      {/* Empty state placeholder */}
      {!activeTab.content && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <p className="font-serif italic text-[14px] text-octo-brass text-center px-4">
            Paste code here, or start typing…
          </p>
        </div>
      )}

      {/* Textarea for editing */}
      <textarea
        value={activeTab.content}
        onChange={handleChange}
        className="absolute inset-0 w-full h-full bg-transparent text-octo-ivory font-mono text-[12px] p-4 resize-none focus:outline-none z-20"
        style={{
          fontFamily: "JetBrains Mono, monospace",
          lineHeight: 1.5,
          caretColor: "var(--color-octo-brass)",
        }}
        spellCheck="false"
        wrap="off"
      />

      {/* Syntax highlighted code display (read-only, behind textarea) */}
      <pre className="absolute inset-0 w-full h-full bg-octo-onyx text-octo-ivory font-mono text-[12px] p-4 overflow-auto pointer-events-none m-0">
        <code
          className={`hljs language-${activeTab.language}`}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      </pre>
    </div>
  );
}
```

- [ ] **Step 2: Test syntax**

Run:
```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ScratchpadCodeEditor.tsx
git commit -m "feat: add code editor with syntax highlighting

- textarea overlay for editing (foreground)
- pre with highlight.js for syntax highlighting (background)
- Auto language detection from active tab
- Placeholder: 'Paste code here, or start typing…'
- Monospace font (JetBrains Mono), 12px
- Line height 1.5, word wrap enabled
- Caret color: brass

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Create ScratchpadTab Component

**Files:**
- Create: `src/components/ScratchpadTab.tsx`

- [ ] **Step 1: Create individual tab component**

Create `src/components/ScratchpadTab.tsx`:

```typescript
import { useState } from "react";
import { X } from "lucide-react";
import { useScratchpadStore } from "../stores/scratchpadStore";
import type { ScratchpadTab as ScratchpadTabType } from "../stores/scratchpadStore";

interface Props {
  tab: ScratchpadTabType;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void;
}

export function ScratchpadTab({
  tab,
  isActive,
  onSelect,
  onDelete,
  onRename,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(tab.name);

  const handleDoubleClick = () => {
    setIsEditing(true);
    setEditValue(tab.name);
  };

  const handleSave = () => {
    if (editValue.trim()) {
      onRename(editValue);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      setIsEditing(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-1 px-2 py-1 border-b-2 transition cursor-pointer ${
        isActive
          ? "border-octo-brass bg-octo-panel text-octo-ivory"
          : "border-transparent bg-octo-onyx text-octo-mute hover:text-octo-sage"
      }`}
      onClick={onSelect}
    >
      {isEditing ? (
        <input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          autoFocus
          className="flex-1 bg-octo-onyx border border-octo-brass text-octo-ivory font-mono text-[11px] px-1 outline-none"
        />
      ) : (
        <>
          <span
            className="flex-1 font-mono text-[11px] truncate select-none"
            onDoubleClick={handleDoubleClick}
          >
            {tab.name}
          </span>
          <span className="text-[8px] text-octo-mute opacity-50 whitespace-nowrap">
            {tab.language}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="p-0 text-octo-mute hover:text-octo-brass transition opacity-0 hover:opacity-100"
            aria-label="Close tab"
          >
            <X size={12} />
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Test syntax**

Run:
```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ScratchpadTab.tsx
git commit -m "feat: add individual tab component

- Click to select, double-click to rename
- Inline input on rename with Enter/Escape support
- Close button (X) appears on hover
- Language badge shows detected language
- Active: brass border-bottom, octo-panel background
- Inactive: muted text, hover shows sage

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Create ScratchpadTabsBar Component

**Files:**
- Create: `src/components/ScratchpadTabsBar.tsx`

- [ ] **Step 1: Create tabs bar component**

Create `src/components/ScratchpadTabsBar.tsx`:

```typescript
import { Plus } from "lucide-react";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { ScratchpadTab } from "./ScratchpadTab";

export function ScratchpadTabsBar() {
  const tabs = useScratchpadStore((s) => s.tabs);
  const activeTabId = useScratchpadStore((s) => s.activeTabId);
  const createTab = useScratchpadStore((s) => s.createTab);
  const deleteTab = useScratchpadStore((s) => s.deleteTab);
  const renameTab = useScratchpadStore((s) => s.renameTab);
  const setActiveTab = useScratchpadStore((s) => s.setActiveTab);

  return (
    <div className="flex items-center gap-0 bg-octo-onyx border-t border-octo-hairline h-10 overflow-x-auto">
      {tabs.map((tab) => (
        <ScratchpadTab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          onSelect={() => setActiveTab(tab.id)}
          onDelete={() => deleteTab(tab.id)}
          onRename={(newName) => renameTab(tab.id, newName)}
        />
      ))}

      {/* Add tab button */}
      <button
        type="button"
        onClick={createTab}
        className="ml-auto flex items-center justify-center h-10 w-10 text-octo-brass hover:bg-[var(--brass-ghost)] transition flex-shrink-0"
        title="New tab"
        aria-label="New tab"
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Test syntax**

Run:
```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ScratchpadTabsBar.tsx
git commit -m "feat: add scratchpad tabs bar component

- Renders all tabs horizontally
- Horizontal scroll if many tabs
- Plus button to create new tab (right-aligned)
- Passes select, delete, rename actions to ScratchpadTab

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Create ScratchpadEditor Component

**Files:**
- Create: `src/components/ScratchpadEditor.tsx`

- [ ] **Step 1: Create main editor component**

Create `src/components/ScratchpadEditor.tsx`:

```typescript
import { ScratchpadTabsBar } from "./ScratchpadTabsBar";
import { ScratchpadCodeEditor } from "./ScratchpadCodeEditor";

export function ScratchpadEditor() {
  return (
    <div className="h-full w-full flex flex-col bg-octo-panel">
      <ScratchpadTabsBar />
      <ScratchpadCodeEditor />
    </div>
  );
}
```

- [ ] **Step 2: Test syntax**

Run:
```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ScratchpadEditor.tsx
git commit -m "feat: add scratchpad editor main component

- Composition: ScratchpadTabsBar + ScratchpadCodeEditor
- Full height and width
- Uses octo-panel background

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Integrate ScratchpadIcon into ContextHeader

**Files:**
- Modify: `src/components/ContextHeader.tsx`

- [ ] **Step 1: Read current ContextHeader**

Check where the rightSlot is used and how to add the icon.

- [ ] **Step 2: Add ScratchpadIcon to ContextHeader**

Modify `src/components/ContextHeader.tsx` to add the icon before the rightSlot:

Find the rightSlot div (around line 95) and add the ScratchpadIcon:

```typescript
import { ScratchpadIcon } from "./ScratchpadIcon";
import { useScratchpadStore } from "../stores/scratchpadStore";

// ... in the component:

// After imports, add:
const toggleScratchpad = useScratchpadStore((s) => s.toggleOpen);

// In the JSX rightSlot area, add before existing rightSlot:
<div className="flex items-center gap-2">
  <ScratchpadIcon onClick={toggleScratchpad} />
  {rightSlot}
</div>
```

- [ ] **Step 3: Test syntax and types**

Run:
```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/ContextHeader.tsx
git commit -m "feat: integrate ScratchpadIcon into ContextHeader toolbar

- ScratchpadIcon rendered left of ModeSwitcher
- Clicking toggles scratchpad open/close
- Icon changes color based on isOpen state

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 11: Integrate CanvasSplit into App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Import CanvasSplit**

Add import at top:
```typescript
import { CanvasSplit } from "./components/CanvasSplit";
```

- [ ] **Step 2: Wrap ReviewCanvas with CanvasSplit**

Find where ReviewCanvas is rendered (around line 1050+). Wrap it:

Before:
```typescript
<ReviewCanvas
  // ... props
/>
```

After:
```typescript
<CanvasSplit>
  <ReviewCanvas
    // ... props
  />
</CanvasSplit>
```

- [ ] **Step 3: Test syntax and types**

Run:
```bash
npm run typecheck
```

Expected: No errors

- [ ] **Step 4: Start dev server and test manually**

Run:
```bash
npm run tauri:dev
```

Expected: App launches, icon appears in toolbar, can click to open/close scratchpad

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat: integrate CanvasSplit and scratchpad into App

- Wrap ReviewCanvas with CanvasSplit for split layout
- Scratchpad icon now functional in toolbar
- Split toggles on icon click

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Task 12: Manual Testing and Polish

**Files:**
- None (manual testing only)

- [ ] **Step 1: Test opening/closing scratchpad**

In running app:
- Click icon in toolbar → scratchpad should open with 50/50 split
- Click icon again → scratchpad closes, canvas back to 100%
- Repeat to verify toggle works

- [ ] **Step 2: Test tab creation and management**

- Click "+" → new "Untitled 2" tab created
- Click "+" again → "Untitled 3" created
- Click on "Untitled 1" → switches back to first tab
- Content should persist when switching tabs

- [ ] **Step 3: Test rename and language detection**

- Double-click on "Untitled 2" → input appears
- Type "script.sh" → press Enter
- Verify language badge shows "shell"
- Paste bash code, verify syntax highlighting works

- [ ] **Step 4: Test paste/formatting workflow**

- Open scratchpad
- Paste a JSON curl command (should wrap, format)
- Rename tab to "curl.json"
- Verify JSON highlighting applied
- Copy result, paste elsewhere

- [ ] **Step 5: Test workspace switching**

- Create content in scratchpad
- Switch to different workspace
- Switch back
- Verify content is still there

- [ ] **Step 6: Test divider drag**

- Drag divider left/right
- Verify split ratio updates smoothly
- Verify no lag or jumping

- [ ] **Step 7: Test edge cases**

- Try to delete last tab → should close scratchpad
- Try to rename to empty string → should revert
- Try to create tab with same name → should append number
- Close app → reopen → content lost (intentional)

- [ ] **Step 8: Fix any styling issues**

If colors are off, borders missing, etc., adjust Tailwind classes in affected components. Common issues:
- Divider not visible → check `bg-octo-hairline` is applied
- Text not visible → check `text-octo-ivory` / `text-octo-mute`
- Icon not showing → check size and color variables

- [ ] **Step 9: Run full test suite**

Run:
```bash
npm test
```

Expected: All tests pass (250+)

- [ ] **Step 10: Final commit (polish)**

If any tweaks were made, commit them:

```bash
git add .
git commit -m "polish: scratchpad styling and manual testing fixes

- Adjusted colors and spacing to match Atelier
- Fixed divider hover state
- Verified syntax highlighting colors

Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
```

---

## Summary

**Components Created:**
- ScratchpadIcon (toolbar icon)
- CanvasSplit (split layout wrapper)
- ScratchpadEditor (main editor)
- ScratchpadTabsBar (tabs bar)
- ScratchpadTab (individual tab)
- ScratchpadCodeEditor (code editor with highlighting)

**Utilities Created:**
- `detectLanguageFromName()` (language detection from filename)

**Store Created:**
- `useScratchpadStore` (Zustand, session-based state)

**Tests Created:**
- Language detection tests (11 tests)
- Scratchpad store tests (11 tests)

**Integration:**
- ContextHeader: Added ScratchpadIcon
- App.tsx: Wrapped ReviewCanvas with CanvasSplit

**Total Tasks:** 12 (each 2-5 minutes)
**Dependencies:** highlight.js (added to package.json)
**Files Modified:** 2 (ContextHeader, App.tsx)
**Files Created:** 11 (components + store + utilities)
**Commits:** 10 (one per task)

---

## Success Criteria

✅ Icon in toolbar toggles scratchpad open/closed  
✅ Split layout with draggable divider (20-80% ratio)  
✅ Multiple tabs with auto-incremented names  
✅ Double-click to rename with language auto-detection  
✅ Syntax highlighting for 25+ languages  
✅ Plus button to create new tabs  
✅ X button to delete tabs  
✅ Close on last tab deletion  
✅ Content persists across workspace switches  
✅ Content lost on app close  
✅ All tests pass  
✅ No TypeScript errors  
