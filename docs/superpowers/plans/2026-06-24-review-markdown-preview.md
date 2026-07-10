# REVIEW Markdown Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a side-by-side rendered Markdown preview to REVIEW mode's Editor view — an icon-only `Eye` toggle splits the editor pane into source ‖ rendered, with a draggable, persisted divider.

**Architecture:** A new `EditorWithPreview` wrapper composes the existing `EditorPane` (always mounted) with a new `MarkdownPreview` pane (collapsible, mounted) in a horizontal split. The `Eye` toggle lives in `ReviewCanvas`'s toolbar; both the toggle and the split read shared persisted state from `reviewPrefsStore`. Rendering reuses `react-markdown` plus a new `remark-gfm` dependency through a new document-grade component map.

**Tech Stack:** React 19 + TypeScript, Zustand (persist middleware), Tailwind v4 tokens, `react-markdown` v10, `remark-gfm` v4, lucide-react, Vitest + Testing Library.

## Global Constraints

Every task implicitly includes these (verbatim from the spec / CLAUDE.md):

- **Tokens only.** No hex colors, no font-family literals. Use `text-octo-*` classes and `var(--brass-ghost)` / `var(--brass-dim)` / `var(--color-octo-*)`. Mirror the existing `ReviewCanvas` toolbar toggle styling.
- **English-only** for every visible string, `aria-label`, and `title`.
- **Icon + `title` tooltip always** — never a bare icon.
- **Motion:** width transitions use the canonical `280ms cubic-bezier(0.2,0.8,0.3,1)`. Disable the transition while dragging. Respect `prefers-reduced-motion` (no animation when reduced). Never mount/unmount abruptly; never remount `EditorPane`.
- **Security:** do **not** add `rehype-raw` or enable raw HTML. Reviewed Markdown is untrusted; embedded HTML/scripts must render inert as text.
- **Markdown detection:** `kind === "text" && (lang === "markdown" || /\.(md|markdown|mdx)$/i.test(path))`.
- **Dependency:** `remark-gfm` pinned `^4`.
- **TDD, frequent commits.** Every commit ends with these two trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
  ```
- **Gates:** `npm run typecheck` clean and `npm test` green before the feature is considered complete.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` | Add `remark-gfm` | Modify |
| `src/lib/isMarkdownFile.ts` | Pure helper: is an `OpenFile` a Markdown doc? | Create |
| `src/lib/isMarkdownFile.test.ts` | Helper tests | Create |
| `src/stores/reviewPrefsStore.ts` | Add `mdPreview` + `mdPreviewSplit` + actions | Modify |
| `src/stores/reviewPrefsStore.test.ts` | Store tests | Create |
| `src/lib/markdownComponents.tsx` | Document-grade `react-markdown` component map | Create |
| `src/components/editor/MarkdownPreview.tsx` | The rendered pane (ReactMarkdown + remark-gfm) | Create |
| `src/components/editor/MarkdownPreview.test.tsx` | Pane render + security tests | Create |
| `src/components/editor/EditorWithPreview.tsx` | Horizontal split + draggable divider | Create |
| `src/components/editor/EditorWithPreview.test.tsx` | Gating + divider tests | Create |
| `src/components/ReviewCanvas.tsx` | Add the `Eye` toggle to the toolbar | Modify |
| `src/components/ReviewCanvas.test.tsx` | Toggle visibility + behavior tests | Modify |
| `src/App.tsx:1667-1671` | Swap `EditorPane` → `EditorWithPreview` | Modify |

---

## Task 1: Add `remark-gfm` dependency

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: the `remark-gfm` module, imported by Task 4's `MarkdownPreview`.

- [ ] **Step 1: Install the dependency**

Run:
```bash
npm install remark-gfm@^4
```
Expected: installs `remark-gfm` (v4.x); `package.json` `dependencies` gains `"remark-gfm": "^4.x.x"`.

- [ ] **Step 2: Verify it resolves**

Run:
```bash
node -e "import('remark-gfm').then(m => console.log('ok', typeof m.default))"
```
Expected: `ok function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
build(review): add remark-gfm for Markdown preview tables/task-lists

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
EOF
)"
```

---

## Task 2: `isMarkdownFile` helper

**Files:**
- Create: `src/lib/isMarkdownFile.ts`
- Test: `src/lib/isMarkdownFile.test.ts`

**Interfaces:**
- Consumes: the `OpenFile` shape from `src/stores/editorStore.ts` (`{ path: string; lang: string; kind: "text" | "binary" }` — only those three fields are read).
- Produces: `export function isMarkdownFile(file: { path: string; lang: string; kind: "text" | "binary" } | null | undefined): boolean`. Used by `ReviewCanvas` (Task 6) and `EditorWithPreview` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `src/lib/isMarkdownFile.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isMarkdownFile } from "./isMarkdownFile";

describe("isMarkdownFile", () => {
  it("is true for a text file whose lang is markdown", () => {
    expect(isMarkdownFile({ path: "/r/README.md", lang: "markdown", kind: "text" })).toBe(true);
  });

  it("is true for .markdown and .mdx by extension even if lang differs", () => {
    expect(isMarkdownFile({ path: "/r/NOTES.markdown", lang: "plain", kind: "text" })).toBe(true);
    expect(isMarkdownFile({ path: "/r/doc.mdx", lang: "plain", kind: "text" })).toBe(true);
  });

  it("is false for non-markdown text files", () => {
    expect(isMarkdownFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" })).toBe(false);
  });

  it("is false for a binary file even with a .md path", () => {
    expect(isMarkdownFile({ path: "/r/weird.md", lang: "markdown", kind: "binary" })).toBe(false);
  });

  it("is false for null / undefined", () => {
    expect(isMarkdownFile(null)).toBe(false);
    expect(isMarkdownFile(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/isMarkdownFile.test.ts`
Expected: FAIL — `isMarkdownFile` is not exported / module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/isMarkdownFile.ts`:
```ts
/** True when an open editor file is a Markdown document we can render a
 *  preview for. Detection is by language first (the editor store classifies
 *  `.md`/`.markdown` as "markdown") with an extension fallback that also
 *  catches `.mdx`. Binary files never qualify. */
export function isMarkdownFile(
  file: { path: string; lang: string; kind: "text" | "binary" } | null | undefined,
): boolean {
  if (!file || file.kind !== "text") return false;
  return file.lang === "markdown" || /\.(md|markdown|mdx)$/i.test(file.path);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/isMarkdownFile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/isMarkdownFile.ts src/lib/isMarkdownFile.test.ts
git commit -m "$(cat <<'EOF'
feat(review): isMarkdownFile helper for preview gating

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
EOF
)"
```

---

## Task 3: `reviewPrefsStore` — preview state

**Files:**
- Modify: `src/stores/reviewPrefsStore.ts`
- Test: `src/stores/reviewPrefsStore.test.ts` (create)

**Interfaces:**
- Consumes: existing `useReviewPrefs` store (zustand + persist, name `octo-review-prefs`).
- Produces, added to the store: `mdPreview: boolean` (default `true`); `mdPreviewSplit: number` (default `50`, source-column percent); `toggleMdPreview(): void`; `setMdPreviewSplit(pct: number): void` (clamps to 25–75). Consumed by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test**

Create `src/stores/reviewPrefsStore.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useReviewPrefs } from "./reviewPrefsStore";

function reset() {
  useReviewPrefs.setState({ mdPreview: true, mdPreviewSplit: 50 });
}

describe("reviewPrefsStore — markdown preview", () => {
  beforeEach(reset);

  it("defaults mdPreview to true and mdPreviewSplit to 50", () => {
    expect(useReviewPrefs.getState().mdPreview).toBe(true);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(50);
  });

  it("toggleMdPreview flips the flag", () => {
    useReviewPrefs.getState().toggleMdPreview();
    expect(useReviewPrefs.getState().mdPreview).toBe(false);
    useReviewPrefs.getState().toggleMdPreview();
    expect(useReviewPrefs.getState().mdPreview).toBe(true);
  });

  it("setMdPreviewSplit clamps to 25..75", () => {
    useReviewPrefs.getState().setMdPreviewSplit(40);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(40);
    useReviewPrefs.getState().setMdPreviewSplit(5);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(25);
    useReviewPrefs.getState().setMdPreviewSplit(95);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(75);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/stores/reviewPrefsStore.test.ts`
Expected: FAIL — `toggleMdPreview is not a function` / `mdPreview` undefined.

- [ ] **Step 3: Write the implementation**

Edit `src/stores/reviewPrefsStore.ts`. Update the `ReviewPrefsState` interface and the store body. The full file becomes:
```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

interface ReviewPrefsState {
  readingMode: ReadingMode;
  ignoreWhitespace: boolean;
  /** Per-workspace "show gitignored files in the tree" pref, keyed by rootPath. */
  showIgnoredFiles: Record<string, boolean>;
  /** Markdown preview: open the rendered pane beside the editor for .md tabs. */
  mdPreview: boolean;
  /** Source-column width percent for the editor‖preview split (25..75). */
  mdPreviewSplit: number;
  setReadingMode: (m: ReadingMode) => void;
  setIgnoreWhitespace: (v: boolean) => void;
  toggleShowIgnored: (rootPath: string) => void;
  toggleMdPreview: () => void;
  setMdPreviewSplit: (pct: number) => void;
}

export const useReviewPrefs = create<ReviewPrefsState>()(
  persist(
    (set) => ({
      readingMode: "inline",
      ignoreWhitespace: false,
      showIgnoredFiles: {},
      mdPreview: true,
      mdPreviewSplit: 50,
      setReadingMode: (readingMode) => set({ readingMode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
      toggleShowIgnored: (rootPath) =>
        set((s) => {
          const next = { ...s.showIgnoredFiles };
          if (next[rootPath]) {
            delete next[rootPath];
          } else {
            next[rootPath] = true;
          }
          return { showIgnoredFiles: next };
        }),
      toggleMdPreview: () => set((s) => ({ mdPreview: !s.mdPreview })),
      setMdPreviewSplit: (pct) =>
        set({ mdPreviewSplit: Math.max(25, Math.min(75, pct)) }),
    }),
    { name: "octo-review-prefs" },
  ),
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/stores/reviewPrefsStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/stores/reviewPrefsStore.ts src/stores/reviewPrefsStore.test.ts
git commit -m "$(cat <<'EOF'
feat(review): persisted mdPreview + split-ratio prefs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
EOF
)"
```

---

## Task 4: `markdownComponents` map + `MarkdownPreview` pane

**Files:**
- Create: `src/lib/markdownComponents.tsx`
- Create: `src/components/editor/MarkdownPreview.tsx`
- Test: `src/components/editor/MarkdownPreview.test.tsx`

**Interfaces:**
- Consumes: `react-markdown` (`ReactMarkdown`, `Components`), `remark-gfm` (Task 1).
- Produces:
  - `src/lib/markdownComponents.tsx` → `export function markdownComponents(): Components`
  - `src/components/editor/MarkdownPreview.tsx` → `export function MarkdownPreview({ source }: { source: string }): JSX.Element`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/components/editor/MarkdownPreview.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders headings, lists, and inline emphasis", () => {
    render(<MarkdownPreview source={"# Title\n\nHello **bold** world\n\n- one\n- two"} />);
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders a GFM table (remark-gfm enabled)", () => {
    const src = "| A | B |\n| - | - |\n| 1 | 2 |";
    render(<MarkdownPreview source={src} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "A" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
  });

  it("renders GFM task-list checkboxes", () => {
    render(<MarkdownPreview source={"- [x] done\n- [ ] todo"} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it("does NOT execute raw HTML — it renders inert as text", () => {
    render(<MarkdownPreview source={"<script>window.__x=1</script>\n\n<b>nothonored</b>"} />);
    // No live <script>/<b> element is created from the source HTML.
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByText("nothonored", { selector: "b" })).toBeNull();
    // The literal characters survive as visible text.
    expect(screen.getByText(/nothonored<\/b>|<b>nothonored<\/b>/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/editor/MarkdownPreview.test.tsx`
Expected: FAIL — `MarkdownPreview` module not found.

- [ ] **Step 3: Write the component map**

Create `src/lib/markdownComponents.tsx`. A document-grade map (real h1–h6 serif scale, plain hairline `hr` — NOT the retired brass gradient — full GFM table/list/code styling), tokens only:
```tsx
import { clsx } from "clsx";
import type { Components } from "react-markdown";

/** Document-grade renderers for the REVIEW Markdown preview, styled with
 *  Onyx & Brass tokens. Separate from ChatMessage's chat-tuned map (which
 *  renders h3 as a brass eyebrow and hr as the retired brass gradient). */
export function markdownComponents(): Components {
  return {
    h1: ({ children }) => (
      <h1 className="mb-3 mt-5 font-serif text-[22px] leading-tight tracking-[-0.01em] text-octo-ivory first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-5 font-serif text-[18px] leading-tight text-octo-ivory first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-2 mt-4 font-serif text-[15px] text-octo-ivory first:mt-0">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1.5 mt-4 font-serif text-[13px] text-octo-ivory first:mt-0">{children}</h4>
    ),
    h5: ({ children }) => (
      <h5 className="mb-1.5 mt-3 font-mono text-[10px] uppercase tracking-[0.22em] text-octo-brass first:mt-0">{children}</h5>
    ),
    h6: ({ children }) => (
      <h6 className="mb-1.5 mt-3 font-mono text-[9px] uppercase tracking-[0.22em] text-octo-mute first:mt-0">{children}</h6>
    ),
    p: ({ children }) => (
      <p className="mb-3 font-sans text-[13px] leading-[1.6] text-octo-sage last:mb-0">{children}</p>
    ),
    strong: ({ children }) => <strong className="font-semibold text-octo-ivory">{children}</strong>,
    em: ({ children }) => <em className="font-medium text-octo-ivory">{children}</em>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener"
         className="text-octo-brass underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass">
        {children}
      </a>
    ),
    ul: ({ children }) => (
      <ul className="mb-3 ml-5 list-disc space-y-1 text-[13px] leading-[1.6] text-octo-sage marker:text-octo-brass last:mb-0">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-3 ml-5 list-decimal space-y-1 text-[13px] leading-[1.6] text-octo-sage marker:text-octo-mute last:mb-0">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-[1.6]">{children}</li>,
    input: ({ checked, type }) =>
      type === "checkbox" ? (
        <input type="checkbox" checked={!!checked} readOnly
               className="mr-1.5 accent-[var(--color-octo-brass)] align-middle" />
      ) : null,
    blockquote: ({ children }) => (
      <blockquote className="my-3 py-1 pl-3 text-octo-sage"
                  style={{ borderLeft: "2px solid var(--brass-dim)" }}>
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-5 h-px border-0 bg-octo-hairline" />,
    code: ({ className, children, ...rest }) => {
      const isInline = !className;
      if (isInline) {
        return (
          <code className="rounded-[3px] px-1.5 py-0.5 font-mono text-[12px] text-octo-brass"
                style={{ background: "var(--brass-ghost)" }} {...rest}>
            {children}
          </code>
        );
      }
      return (
        <code className={clsx("block overflow-x-auto rounded-md border border-octo-hairline bg-octo-onyx p-3 font-mono text-[12px] leading-relaxed text-octo-sage", className)} {...rest}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-md">{children}</pre>,
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-md border border-octo-hairline">
        <table className="w-full text-[12px]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-octo-hairline bg-octo-panel px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border-b border-octo-hairline px-3 py-2 text-octo-sage">{children}</td>
    ),
    img: ({ src, alt }) => (
      <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} className="my-3 max-w-full rounded-md" />
    ),
  };
}
```

- [ ] **Step 4: Write the pane**

Create `src/components/editor/MarkdownPreview.tsx`:
```tsx
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents } from "../../lib/markdownComponents";

/** Rendered Markdown pane for REVIEW's editor split. Renders the live editor
 *  buffer (`source`) with GFM. No rehype-raw: embedded HTML stays inert text. */
export function MarkdownPreview({ source }: { source: string }) {
  const components = useMemo(() => markdownComponents(), []);
  const rendered = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    ),
    [source, components],
  );

  return (
    <div
      data-testid="markdown-preview"
      className="octo-fade-in h-full overflow-auto px-6 py-5"
      style={{ background: "var(--color-octo-onyx)" }}
    >
      <div className="mx-auto max-w-[72ch]">{rendered}</div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/components/editor/MarkdownPreview.test.tsx`
Expected: PASS (4 tests). If the raw-HTML assertion's text matcher is brittle in your jsdom, keep the two structural assertions (`document.querySelector("script")` is null and no `<b>` element) — those are the security guarantee.

- [ ] **Step 6: Commit**

```bash
git add src/lib/markdownComponents.tsx src/components/editor/MarkdownPreview.tsx src/components/editor/MarkdownPreview.test.tsx
git commit -m "$(cat <<'EOF'
feat(review): MarkdownPreview pane + document-grade renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
EOF
)"
```

---

## Task 5: `EditorWithPreview` split + draggable divider

**Files:**
- Create: `src/components/editor/EditorWithPreview.tsx`
- Test: `src/components/editor/EditorWithPreview.test.tsx`

**Interfaces:**
- Consumes: `EditorPane` (props `{ workspaceId, workspacePath, diffText }`), `MarkdownPreview` (`{ source }`, Task 4), `isMarkdownFile` (Task 2), `useEditorStore` (`getActivePath`, `getFiles`), `useReviewPrefs` (`mdPreview`, `mdPreviewSplit`, `setMdPreviewSplit`).
- Produces: `export function EditorWithPreview({ workspaceId, workspacePath, diffText }: { workspaceId: string; workspacePath: string; diffText: string }): JSX.Element`. Consumed by Task 7 (App.tsx).

- [ ] **Step 1: Write the failing test**

Create `src/components/editor/EditorWithPreview.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorWithPreview } from "./EditorWithPreview";
import { useEditorStore } from "../../stores/editorStore";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";
import type { OpenFile } from "../../stores/editorStore";

// Stub the heavy panes — this test is about gating + divider, not CodeMirror.
vi.mock("./EditorPane", () => ({ EditorPane: () => <div data-testid="editor-pane" /> }));
vi.mock("./MarkdownPreview", () => ({
  MarkdownPreview: ({ source }: { source: string }) => <div data-testid="md-preview">{source}</div>,
}));

const WS = "ws1";
function seedFile(partial: Partial<OpenFile> & Pick<OpenFile, "path" | "lang" | "kind">) {
  const file = {
    content: "# Doc", savedContent: "# Doc", mtime: 0, size: 1, version: 0, diskStale: false,
    ...partial,
  } as OpenFile;
  useEditorStore.setState({ filesByWs: { [WS]: [file] }, activeByWs: { [WS]: file.path } });
}

function renderIt() {
  return render(<EditorWithPreview workspaceId={WS} workspacePath="/r" diffText="" />);
}

describe("EditorWithPreview", () => {
  beforeEach(() => {
    useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
    useReviewPrefs.setState({ mdPreview: true, mdPreviewSplit: 50 });
  });

  it("always renders the editor pane", () => {
    seedFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderIt();
    expect(screen.getByTestId("editor-pane")).toBeInTheDocument();
  });

  it("shows the preview for a markdown file when mdPreview is on", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text", content: "# Hi" });
    renderIt();
    expect(screen.getByTestId("md-preview")).toHaveTextContent("# Hi");
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("hides the preview for a non-markdown file", () => {
    seedFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderIt();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("hides the preview when mdPreview is off", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdPreview: false });
    renderIt();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("drag updates the split ratio, clamped to 25..75", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderIt();
    const container = screen.getByTestId("editor-with-preview");
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const divider = screen.getByRole("separator");

    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(document, { clientX: 300 });
    fireEvent.mouseUp(document);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(30);

    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(document, { clientX: 100 }); // 10% -> clamp 25
    fireEvent.mouseUp(document);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(25);
  });

  it("double-click on the divider resets the split to 50", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdPreviewSplit: 30 });
    renderIt();
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(50);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/editor/EditorWithPreview.test.tsx`
Expected: FAIL — `EditorWithPreview` module not found.

- [ ] **Step 3: Write the implementation**

Create `src/components/editor/EditorWithPreview.tsx`:
```tsx
import { useRef } from "react";
import { EditorPane } from "./EditorPane";
import { MarkdownPreview } from "./MarkdownPreview";
import { isMarkdownFile } from "../../lib/isMarkdownFile";
import { useEditorStore } from "../../stores/editorStore";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";

interface Props {
  workspaceId: string;
  workspacePath: string;
  diffText: string;
}

const REDUCED =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
const GROW = REDUCED ? "none" : "width 280ms cubic-bezier(0.2,0.8,0.3,1)";

/** REVIEW editor surface: EditorPane (always mounted) with an optional,
 *  collapsible MarkdownPreview to its right. The preview never unmounts the
 *  editor — it only collapses to zero width — so CodeMirror state survives a
 *  toggle. Divider is draggable (ratio persisted) and double-click-resets. */
export function EditorWithPreview({ workspaceId, workspacePath, diffText }: Props) {
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const mdPreview = useReviewPrefs((s) => s.mdPreview);
  const split = useReviewPrefs((s) => s.mdPreviewSplit);
  const setSplit = useReviewPrefs((s) => s.setMdPreviewSplit);

  const activeFile = activePath ? files.find((f) => f.path === activePath) ?? null : null;
  const showPreview = mdPreview && isMarkdownFile(activeFile);

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const onDividerMouseDown = () => {
    draggingRef.current = true;
    const onMove = (e: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      setSplit(((e.clientX - rect.left) / rect.width) * 100);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const transition = draggingRef.current ? "none" : GROW;

  return (
    <div ref={containerRef} data-testid="editor-with-preview" className="flex h-full min-h-0 w-full overflow-hidden">
      {/* Editor — always mounted; full width when preview hidden. */}
      <div className="min-h-0 overflow-hidden" style={{ width: showPreview ? `${split}%` : "100%", transition }}>
        <EditorPane workspaceId={workspaceId} workspacePath={workspacePath} diffText={diffText} />
      </div>

      {/* Divider — only interactive when the preview is visible. */}
      {showPreview && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize preview"
          onMouseDown={onDividerMouseDown}
          onDoubleClick={() => setSplit(50)}
          className="w-px shrink-0 cursor-col-resize bg-octo-hairline transition-colors hover:bg-octo-brass"
        />
      )}

      {/* Preview — mounted, width-collapsed when hidden (never remounts editor). */}
      <div
        className="min-h-0 overflow-hidden"
        style={{
          width: showPreview ? `${100 - split}%` : "0%",
          visibility: showPreview ? "visible" : "hidden",
          transition,
        }}
      >
        {activeFile && <MarkdownPreview source={activeFile.content} />}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/components/editor/EditorWithPreview.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/EditorWithPreview.tsx src/components/editor/EditorWithPreview.test.tsx
git commit -m "$(cat <<'EOF'
feat(review): EditorWithPreview split with draggable divider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
EOF
)"
```

---

## Task 6: `ReviewCanvas` — the `Eye` toggle

**Files:**
- Modify: `src/components/ReviewCanvas.tsx`
- Test: `src/components/ReviewCanvas.test.tsx`

**Interfaces:**
- Consumes: `useEditorStore` (`getActivePath`, `getFiles`), `isMarkdownFile` (Task 2), `useReviewPrefs` (`mdPreview`, `toggleMdPreview`), lucide `Eye`. `ReviewCanvas` already has `workspaceId` and `viewMode` in scope.
- Produces: a toolbar button with `aria-label="Toggle rendered preview"`, shown only when `viewMode === "editor"` and the active file is Markdown.

- [ ] **Step 1: Write the failing test**

Add to `src/components/ReviewCanvas.test.tsx` (new `describe` block; reuse the file's existing imports / mocks — it already mocks `ipc`). Add at the top-level of the file the store imports if not present:
```tsx
import { useEditorStore } from "../stores/editorStore";
import { useReviewPrefs } from "../stores/reviewPrefsStore";
import type { OpenFile } from "../stores/editorStore";
```
Then the block:
```tsx
describe("ReviewCanvas — markdown preview toggle", () => {
  const WS = "wsR";
  function seed(file: Pick<OpenFile, "path" | "lang" | "kind">) {
    const f = { content: "# D", savedContent: "# D", mtime: 0, size: 1, version: 0, diskStale: false, ...file } as OpenFile;
    useEditorStore.setState({ filesByWs: { [WS]: [f] }, activeByWs: { [WS]: f.path } });
  }
  beforeEach(() => {
    useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
    useReviewPrefs.setState({ mdPreview: true });
  });

  function renderCanvas(viewMode: "diff" | "editor") {
    return render(
      <ReviewCanvas workspaceId={WS} workspacePath="/r" gitStatus={null} gitDiff="" viewMode={viewMode} onViewModeChange={() => {}}>
        <div />
      </ReviewCanvas>,
    );
  }

  it("shows the Eye toggle in editor mode for a markdown file", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor");
    expect(screen.getByRole("button", { name: /toggle rendered preview/i })).toBeInTheDocument();
  });

  it("hides the toggle in diff mode", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("diff");
    expect(screen.queryByRole("button", { name: /toggle rendered preview/i })).toBeNull();
  });

  it("hides the toggle for a non-markdown file", () => {
    seed({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderCanvas("editor");
    expect(screen.queryByRole("button", { name: /toggle rendered preview/i })).toBeNull();
  });

  it("clicking the toggle flips the mdPreview pref", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor");
    fireEvent.click(screen.getByRole("button", { name: /toggle rendered preview/i }));
    expect(useReviewPrefs.getState().mdPreview).toBe(false);
  });
});
```
If `fireEvent` / `screen` aren't already imported in this test file, add them: `import { render, screen, fireEvent } from "@testing-library/react";`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/components/ReviewCanvas.test.tsx`
Expected: FAIL — no button named "toggle rendered preview".

- [ ] **Step 3: Add the imports**

In `src/components/ReviewCanvas.tsx`, add `Eye` to the existing `lucide-react` import (alongside `Play, Loader2, …`), and add these imports near the other store imports:
```tsx
import { Eye } from "lucide-react";
import { useEditorStore } from "../stores/editorStore";
import { isMarkdownFile } from "../lib/isMarkdownFile";
```
(`useReviewPrefs` is already imported.)

- [ ] **Step 4: Read the active file + pref inside the component**

In `ReviewCanvas`, just after the existing `useReviewPrefs` selector lines (`readingMode`, `ignoreWhitespace`, …), add:
```tsx
  const mdPreview = useReviewPrefs((s) => s.mdPreview);
  const toggleMdPreview = useReviewPrefs((s) => s.toggleMdPreview);
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const editorFiles = useEditorStore((s) => s.getFiles(workspaceId));
  const activeEditorFile = activePath
    ? editorFiles.find((f) => f.path === activePath) ?? null
    : null;
  const showPreviewToggle = viewMode === "editor" && isMarkdownFile(activeEditorFile);
```

- [ ] **Step 5: Render the toggle button**

In the toolbar, immediately after the closing `</div>` of the Diff/Editor view-toggle group (the `<div className="flex shrink-0 items-center overflow-hidden rounded-md border border-octo-hairline">` that contains the Diff and Editor buttons), insert:
```tsx
          {/* Rendered Markdown preview toggle — editor view, .md files only */}
          {showPreviewToggle && (
            <button
              onClick={toggleMdPreview}
              aria-label="Toggle rendered preview"
              aria-pressed={mdPreview}
              title="Toggle rendered preview"
              className={`flex shrink-0 items-center justify-center rounded-md border border-octo-hairline px-2 py-1 transition-colors focus-visible:ring-1 focus-visible:ring-octo-brass ${
                mdPreview ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
              }`}
              style={mdPreview ? { background: "var(--brass-ghost)", borderColor: "var(--brass-dim)" } : undefined}
            >
              <Eye size={13} />
            </button>
          )}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- src/components/ReviewCanvas.test.tsx`
Expected: PASS (4 new tests; existing tests still pass).

- [ ] **Step 7: Commit**

```bash
git add src/components/ReviewCanvas.tsx src/components/ReviewCanvas.test.tsx
git commit -m "$(cat <<'EOF'
feat(review): Eye toggle for the Markdown preview split

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
EOF
)"
```

---

## Task 7: Wire `EditorWithPreview` into App.tsx + full verification

**Files:**
- Modify: `src/App.tsx` (import + lines 1666-1671)

**Interfaces:**
- Consumes: `EditorWithPreview` (Task 5).

- [ ] **Step 1: Swap the import**

In `src/App.tsx`, replace the `EditorPane` import (line 29):
```tsx
import { EditorPane } from "./components/EditorPane";
```
with:
```tsx
import { EditorWithPreview } from "./components/editor/EditorWithPreview";
```
(`EditorPane` is no longer referenced directly in App.tsx after Step 2; removing its import keeps the file lint-clean.)

- [ ] **Step 2: Swap the component in the ReviewCanvas children**

Replace the editor child (currently lines ~1667-1671):
```tsx
                        <EditorPane
                          workspaceId={activeWorkspaceId!}
                          workspacePath={activeWorkspace.worktreePath || project.path}
                          diffText={gitDiff}
                        />
```
with:
```tsx
                        <EditorWithPreview
                          workspaceId={activeWorkspaceId!}
                          workspacePath={activeWorkspace.worktreePath || project.path}
                          diffText={gitDiff}
                        />
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If TypeScript reports `EditorPane` is declared but never used elsewhere, confirm Step 1 removed its import.)

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all files green, including the new `isMarkdownFile`, `reviewPrefsStore`, `MarkdownPreview`, `EditorWithPreview`, and `ReviewCanvas` tests.

- [ ] **Step 5: Manual smoke (real app)**

Run: `npm run tauri:dev`. In a workspace with a changed `.md` file: open REVIEW → **Editor** → open the `.md` tab. Confirm: the rendered preview shows to the right by default; the `Eye` toggle hides/shows it; the divider drags and the ratio sticks after reload; switching to a `.ts` tab hides the preview and the toggle; switching back restores it. Confirm a non-`.md` file and Diff view never show the toggle.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "$(cat <<'EOF'
feat(review): mount EditorWithPreview in REVIEW editor view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017gb5rQWxa4HJ6D4XFxLHwE
EOF
)"
```

---

## Self-Review (completed)

**Spec coverage** — every spec section maps to a task:
- §3 toggle visibility / default / live preview / divider → Tasks 3, 5, 6.
- §4 architecture (markdownComponents, MarkdownPreview, EditorWithPreview, ReviewCanvas, reviewPrefsStore, App.tsx, package.json) → Tasks 1, 3, 4, 5, 6, 7.
- §4 Markdown detection helper → Task 2.
- §5 rendering details + remark-gfm → Tasks 1, 4.
- §6 resizable divider (clamp, persist, reset, no-remount, no-transition-during-drag) → Tasks 3, 5.
- §7 motion / tokens → Tasks 4, 5 (canonical easing, reduced-motion, octo-fade-in).
- §8 security (no rehype-raw) → Task 4 (test + implementation).
- §9 edge cases (tab switch, no file, binary, reduced motion, old prefs) → Tasks 2, 3, 5.
- §10 testing → every task is TDD.

**Placeholder scan** — no TBD/TODO; every code step shows complete code; commit messages are concrete.

**Type consistency** — `isMarkdownFile(file)` signature is identical in Tasks 2/5/6; `MarkdownPreview({ source })`, `markdownComponents()`, `EditorWithPreview({ workspaceId, workspacePath, diffText })`, and the store members (`mdPreview`, `mdPreviewSplit`, `toggleMdPreview`, `setMdPreviewSplit`) are referenced with matching names/types across tasks.
