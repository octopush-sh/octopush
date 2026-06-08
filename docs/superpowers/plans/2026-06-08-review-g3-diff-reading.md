# G3 · Diff Reading Experience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn Review's diff into a hybrid continuous, syntax-highlighted, word-diffed, keyboard-triaged surface with collapse/"viewed" and an inline/side-by-side toggle — without changing staging semantics (G4) or adding AI (G5).

**Architecture:** Decompose the 722-line `ReviewCanvas.tsx` into a thin shell + focused `components/review/` sub-components and `lib/` helpers; extend `diffParser.ts`; add a G3-owned Zustand prefs store; add two additive Rust commands. Reuse the editor's CodeMirror language + Atelier palette for diff highlighting.

**Tech Stack:** React 19 + TS, Zustand, CodeMirror 6 (`@codemirror/lang-*`, `@lezer/highlight`), Tailwind v4 tokens, `git2` (libgit2), Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-08-review-g3-diff-reading-design.md`. **Branch:** create `feat/review-g3-diff` off `feat/review-mode`. Run `npm run typecheck` + `npx vitest run` after each task; keep the suite green.

**Setup (once):**
```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh-review
git checkout feat/review-mode && git checkout -b feat/review-g3-diff
```

---

## Task 1: Establish `review/` folder + Tier-0 fixes

Extract the two pure sub-components out of `ReviewCanvas.tsx`, fixing the design-system bugs in the process. No behavior change.

**Files:**
- Create: `src/components/review/TestDrawer.tsx`, `src/components/review/EmptyDiffState.tsx`
- Modify: `src/components/ReviewCanvas.tsx` (remove the two functions, import them)
- Modify: `src/styles.css` (add `--verdigris-ghost` token if absent)

- [ ] **Step 1: Add the verdigris-ghost token.** In `src/styles.css`, near the existing `--rouge-ghost`/`--brass-ghost` token definitions, add:
```css
--verdigris-ghost: rgba(143, 201, 168, 0.08);
```
Verify `--rouge-ghost` already exists: `grep -n "rouge-ghost" src/styles.css`. If missing, also add `--rouge-ghost: rgba(209, 139, 139, 0.08);`.

- [ ] **Step 2: Create `EmptyDiffState.tsx`** — move the function verbatim from `ReviewCanvas.tsx:704-722`:
```tsx
import { CheckCircle } from "lucide-react";

export function EmptyDiffState({ stagedCount }: { stagedCount: number }) {
  const hasStaged = stagedCount > 0;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <CheckCircle size={24} className="text-octo-brass opacity-60" />
      <div className="font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        {hasStaged ? `${stagedCount} file${stagedCount !== 1 ? "s" : ""} staged.` : "Nothing to review."}
      </div>
      <p className="max-w-xs text-[12px] leading-[1.6] text-octo-sage">
        {hasStaged
          ? "Write a commit message in the Changes rail and commit when you're ready."
          : "When the agent edits files in this workspace, the diff will appear here for hunk-by-hunk approval."}
      </p>
      <div className="h-px w-7 bg-octo-brass/60" aria-hidden />
    </div>
  );
}
```

- [ ] **Step 3: Create `TestDrawer.tsx`** — move from `ReviewCanvas.tsx:316-367`, **fixing the bugs**: `text-octo-text` → `text-octo-ivory`, `text-octo-textMuted` → `text-octo-mute`, and add the entrance motion class. Make stdout/stderr selectable (`select-text`):
```tsx
import { X } from "lucide-react";
import type { TestRunResult } from "../../lib/types";

export function TestDrawer({ result, onClose }: { result: TestRunResult; onClose: () => void }) {
  const isPass = result.exitCode === 0;
  return (
    <div className="octo-rise-in border-t border-octo-hairline bg-octo-bg">
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="font-mono text-xs font-semibold text-octo-ivory">Test output</span>
        <span className={["ml-1 rounded px-2 py-0.5 font-mono text-[10px] font-semibold",
          isPass ? "bg-octo-success/20 text-octo-success" : "bg-octo-danger/20 text-octo-danger"].join(" ")}>
          exit {result.exitCode}
        </span>
        <button onClick={onClose} aria-label="Dismiss" title="Dismiss (Esc)"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage focus-visible:ring-1 focus-visible:ring-octo-brass">
          <X size={14} />
        </button>
      </div>
      <div className="max-h-56 select-text overflow-y-auto px-4 pb-3">
        {result.stdout && <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-octo-ivory">{result.stdout}</pre>}
        {result.stderr && <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-octo-rouge/80">{result.stderr}</pre>}
        {!result.stdout && !result.stderr && <p className="text-xs text-octo-mute">(no output)</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update `ReviewCanvas.tsx`** — delete the `TestDrawer` and `EmptyDiffState` function definitions; add imports at top: `import { TestDrawer } from "./review/TestDrawer";` and `import { EmptyDiffState } from "./review/EmptyDiffState";`. Also fix the two inline rgba in `DiffLine` (`:297`, `:307`): replace `style={{ background: "rgba(143, 201, 168, 0.08)" }}` → `style={{ background: "var(--verdigris-ghost)" }}` and `"rgba(209, 139, 139, 0.08)"` → `"var(--rouge-ghost)"`. Replace `transition-all duration-200` (`:142`) → `transition-all duration-[var(--dur-quick)]`.

- [ ] **Step 5: Verify + commit.**
```bash
npm run typecheck && npx vitest run
git add src/components/review/TestDrawer.tsx src/components/review/EmptyDiffState.tsx src/components/ReviewCanvas.tsx src/styles.css
git commit -m "refactor(g3): extract TestDrawer/EmptyDiffState + Tier-0 token/motion fixes"
```
Expected: typecheck clean, tests green, `git diff feat/review-mode -- src | grep -nE '#[0-9a-fA-F]{3,8}'` empty.

---

## Task 2: `reviewPrefsStore` (persisted reading mode + whitespace)

**Files:**
- Create: `src/stores/reviewPrefsStore.ts`
- Test: `src/stores/reviewPrefsStore.test.ts`

- [ ] **Step 1: Write the failing test.**
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useReviewPrefs } from "./reviewPrefsStore";

describe("reviewPrefsStore", () => {
  beforeEach(() => { localStorage.clear(); useReviewPrefs.setState({ readingMode: "inline", ignoreWhitespace: false }); });
  it("defaults to inline + whitespace-sensitive", () => {
    expect(useReviewPrefs.getState().readingMode).toBe("inline");
    expect(useReviewPrefs.getState().ignoreWhitespace).toBe(false);
  });
  it("toggles and persists reading mode", () => {
    useReviewPrefs.getState().setReadingMode("sbs");
    expect(useReviewPrefs.getState().readingMode).toBe("sbs");
    expect(localStorage.getItem("octo-review-prefs")).toContain("sbs");
  });
  it("toggles whitespace", () => {
    useReviewPrefs.getState().setIgnoreWhitespace(true);
    expect(useReviewPrefs.getState().ignoreWhitespace).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — fails** (`npx vitest run src/stores/reviewPrefsStore.test.ts`): "Cannot find module".

- [ ] **Step 3: Implement** (mirror the persist pattern used by other stores — check an existing one e.g. `src/stores/themeStore.ts` for the project's persist idiom):
```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ReadingMode = "inline" | "sbs";

interface ReviewPrefsState {
  readingMode: ReadingMode;
  ignoreWhitespace: boolean;
  setReadingMode: (m: ReadingMode) => void;
  setIgnoreWhitespace: (v: boolean) => void;
}

export const useReviewPrefs = create<ReviewPrefsState>()(
  persist(
    (set) => ({
      readingMode: "inline",
      ignoreWhitespace: false,
      setReadingMode: (readingMode) => set({ readingMode }),
      setIgnoreWhitespace: (ignoreWhitespace) => set({ ignoreWhitespace }),
    }),
    { name: "octo-review-prefs" },
  ),
);
```

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/stores/reviewPrefsStore.ts src/stores/reviewPrefsStore.test.ts
git commit -m "feat(g3): reviewPrefsStore — persisted reading mode + whitespace toggle"
```

---

## Task 3: `lib/wordDiff.ts` — intra-line word diff

**Files:**
- Create: `src/lib/wordDiff.ts`
- Test: `src/lib/wordDiff.test.ts`

- [ ] **Step 1: Write the failing test.**
```ts
import { describe, it, expect } from "vitest";
import { wordDiff } from "./wordDiff";

describe("wordDiff", () => {
  it("marks only the changed word", () => {
    const { old: o, new: n } = wordDiff(`return "Hi " + name`, "return `Hello, ${name}`");
    expect(o.filter(s => s.kind === "del").map(s => s.text).join("")).toContain('"Hi " + ');
    expect(n.filter(s => s.kind === "add").map(s => s.text).join("")).toContain("`Hello, ${");
    expect(o.filter(s => s.kind === "equal").map(s => s.text).join("")).toContain("return ");
  });
  it("identical lines are all equal", () => {
    const { old: o, new: n } = wordDiff("const x = 1", "const x = 1");
    expect(o.every(s => s.kind === "equal")).toBe(true);
    expect(n.every(s => s.kind === "equal")).toBe(true);
  });
  it("pure insertion", () => {
    const { old: o, new: n } = wordDiff("a c", "a b c");
    expect(o.some(s => s.kind === "del")).toBe(false);
    expect(n.some(s => s.kind === "add" && s.text.includes("b"))).toBe(true);
  });
  it("falls back to whole-line on huge token counts", () => {
    const big = Array.from({ length: 500 }, (_, i) => `t${i}`).join(" ");
    const { old: o } = wordDiff(big, big + " x");
    expect(o).toEqual([{ kind: "equal", text: big }]); // fallback: single equal seg for old
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement** (token LCS; tokens = whitespace | word | punctuation runs):
```ts
export interface WordSegment { kind: "equal" | "add" | "del"; text: string; }

const TOKEN_RE = /(\s+|\w+|[^\s\w]+)/g;
const MAX_TOKENS = 400;

function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

/** LCS table over two token arrays; returns aligned ops. */
export function wordDiff(oldText: string, newText: string): { old: WordSegment[]; new: WordSegment[] } {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return { old: [{ kind: "equal", text: oldText }], new: [{ kind: "equal", text: newText }] };
  }
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const oldSegs: WordSegment[] = [], newSegs: WordSegment[] = [];
  const push = (segs: WordSegment[], kind: WordSegment["kind"], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind) last.text += text; else segs.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { push(oldSegs, "equal", a[i]); push(newSegs, "equal", b[j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(oldSegs, "del", a[i]); i++; }
    else { push(newSegs, "add", b[j]); j++; }
  }
  while (i < m) push(oldSegs, "del", a[i++]);
  while (j < n) push(newSegs, "add", b[j++]);
  return { old: oldSegs, new: newSegs };
}
```

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/lib/wordDiff.ts src/lib/wordDiff.test.ts
git commit -m "feat(g3): wordDiff — intra-line token LCS"
```

---

## Task 4: Diff syntax highlighting (`lib/diffHighlight.ts` + CSS classes)

Reuse CodeMirror language parsers + the Atelier palette, but emit **CSS classes** (design-token compliant) instead of inline hex.

**Files:**
- Create: `src/lib/diffHighlight.ts`
- Test: `src/lib/diffHighlight.test.ts`
- Modify: `src/styles.css` (add `.tok-*` classes)

- [ ] **Step 1: Add token classes to `styles.css`** (colors mirror `atelierTheme.ts`):
```css
.tok-kw   { color: var(--brass); }
.tok-str  { color: var(--sage); }
.tok-num  { color: var(--rouge); }
.tok-cmt  { color: var(--mute); }
.tok-type { color: var(--brass); }
.tok-fn   { color: var(--ivory); }
.tok-op   { color: var(--sage); }
.tok-var  { color: var(--ivory); }
```
(Confirm the base tokens `--brass/--sage/--rouge/--mute/--ivory` exist in `styles.css`; they back the `text-octo-*` utilities.)

- [ ] **Step 2: Write the failing test.**
```ts
import { describe, it, expect } from "vitest";
import { highlightLine } from "./diffHighlight";

describe("highlightLine", () => {
  it("classes a JS keyword as tok-kw", () => {
    const toks = highlightLine("const x = 1", "src/a.ts");
    const kw = toks.find(t => t.text === "const");
    expect(kw?.cls).toBe("tok-kw");
  });
  it("classes a number as tok-num", () => {
    const toks = highlightLine("const x = 42", "src/a.ts");
    expect(toks.find(t => t.text === "42")?.cls).toBe("tok-num");
  });
  it("plaintext returns one unclassed token", () => {
    const toks = highlightLine("just words here", "notes.txt");
    expect(toks).toEqual([{ text: "just words here", cls: "" }]);
  });
  it("reconstructs the original line exactly", () => {
    const line = "function f(a) { return a + 1 }";
    expect(highlightLine(line, "a.ts").map(t => t.text).join("")).toBe(line);
  });
});
```

- [ ] **Step 3: Run it — fails.**

- [ ] **Step 4: Implement** using `highlightTree` + a class-based `HighlightStyle`. Map `LangId` → CodeMirror `Language` (memoized):
```ts
import { highlightTree } from "@lezer/highlight";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Language } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { langForExtension, type LangId } from "./editorLang";

export interface DiffTok { text: string; cls: string; }

const classStyle = HighlightStyle.define([
  { tag: t.keyword, class: "tok-kw" }, { tag: t.controlKeyword, class: "tok-kw" },
  { tag: t.definitionKeyword, class: "tok-kw" }, { tag: t.moduleKeyword, class: "tok-kw" },
  { tag: t.operatorKeyword, class: "tok-kw" }, { tag: t.bool, class: "tok-kw" },
  { tag: t.string, class: "tok-str" }, { tag: t.special(t.string), class: "tok-str" }, { tag: t.regexp, class: "tok-str" },
  { tag: t.number, class: "tok-num" }, { tag: t.integer, class: "tok-num" }, { tag: t.float, class: "tok-num" },
  { tag: t.comment, class: "tok-cmt" }, { tag: t.lineComment, class: "tok-cmt" }, { tag: t.blockComment, class: "tok-cmt" },
  { tag: t.typeName, class: "tok-type" }, { tag: t.className, class: "tok-type" }, { tag: t.tagName, class: "tok-type" },
  { tag: t.function(t.variableName), class: "tok-fn" }, { tag: t.function(t.propertyName), class: "tok-fn" },
  { tag: t.operator, class: "tok-op" }, { tag: t.punctuation, class: "tok-op" },
  { tag: t.variableName, class: "tok-var" }, { tag: t.propertyName, class: "tok-var" },
]);

const langCache = new Map<LangId, Language | null>();
function langFor(id: LangId): Language | null {
  if (langCache.has(id)) return langCache.get(id)!;
  let lang: Language | null = null;
  switch (id) {
    case "javascript": lang = javascript({ jsx: true, typescript: true }).language; break;
    case "rust": lang = rust().language; break;
    case "python": lang = python().language; break;
    case "java": lang = java().language; break;
    case "json": lang = json().language; break;
    case "markdown": lang = markdown().language; break;
    case "html": lang = html().language; break;
    case "css": lang = css().language; break;
    case "xml": lang = xml().language; break;
    case "yaml": lang = yaml().language; break;
    default: lang = null;
  }
  langCache.set(id, lang);
  return lang;
}

export function highlightLine(text: string, filePath: string): DiffTok[] {
  const lang = langFor(langForExtension(filePath));
  if (!lang || !text) return [{ text, cls: "" }];
  const tree = lang.parser.parse(text);
  const out: DiffTok[] = [];
  let pos = 0;
  highlightTree(tree, classStyle, (from, to, cls) => {
    if (from > pos) out.push({ text: text.slice(pos, from), cls: "" });
    out.push({ text: text.slice(from, to), cls });
    pos = to;
  });
  if (pos < text.length) out.push({ text: text.slice(pos), cls: "" });
  return out;
}
```

- [ ] **Step 5: Run tests — pass.** If a parser's tag mapping differs (e.g. number class), adjust the test's expected class to the actual; keep the "reconstructs original line" invariant test strict.
- [ ] **Step 6: Commit.**
```bash
git add src/lib/diffHighlight.ts src/lib/diffHighlight.test.ts src/styles.css
git commit -m "feat(g3): diffHighlight — class-based syntax highlighting reusing CM languages"
```

---

## Task 5: Extend `diffParser` — structured rows, line numbers, paired word-diff, gutter fix

**Files:**
- Modify: `src/lib/diffParser.ts`
- Test: `src/lib/diffParser.test.ts` (add cases)

- [ ] **Step 1: Write failing tests** (append to existing test file or create it):
```ts
import { describe, it, expect } from "vitest";
import { parseFullDiff } from "./diffParser";

const DIFF = `diff --git a/src/greet.ts b/src/greet.ts
index 111..222 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,3 @@
 function greet(name) {
-  return "Hi " + name
+  return \`Hello, \${name}\`
 }
`;

describe("parseFullDiff rows", () => {
  const file = parseFullDiff(DIFF)[0];
  const hunk = file.hunks[0];
  it("produces structured rows with old/new line numbers", () => {
    expect(hunk.rows.map(r => r.kind)).toEqual(["context", "del", "add", "context"]);
    expect(hunk.rows[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(hunk.rows[1]).toMatchObject({ kind: "del", oldLine: 2, newLine: null });
    expect(hunk.rows[2]).toMatchObject({ kind: "add", oldLine: null, newLine: 2 });
    expect(hunk.rows[3]).toMatchObject({ oldLine: 3, newLine: 3 });
  });
  it("pairs adjacent del/add into word-diff segments", () => {
    expect(hunk.rows[1].segments?.some(s => s.kind === "del")).toBe(true);
    expect(hunk.rows[2].segments?.some(s => s.kind === "add")).toBe(true);
  });
  it("row text drops the +/-/space sign", () => {
    expect(hunk.rows[1].text.startsWith("-")).toBe(false);
    expect(hunk.rows[1].text).toContain("Hi ");
  });
});
```

- [ ] **Step 2: Run it — fails** ("rows is undefined").

- [ ] **Step 3: Implement.** Add the `DiffRow`/`DiffRowKind` types and a `rows` builder; call it inside `buildHunk`. Add `import { wordDiff } from "./wordDiff";`:
```ts
import { wordDiff, type WordSegment } from "./wordDiff";

export type DiffRowKind = "context" | "add" | "del";
export interface DiffRow {
  kind: DiffRowKind;
  text: string;            // line content WITHOUT the +/-/space sign
  oldLine: number | null;
  newLine: number | null;
  segments?: WordSegment[];
}
```
Add `rows: DiffRow[];` to `DiffHunk`. In `buildHunk`, after computing additions/deletions, compute rows from `lines` (skip the `@@` header line) using the header's start numbers, then pair runs:
```ts
function parseHunkHeader(header: string): { oldStart: number; newStart: number } {
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return { oldStart: m ? parseInt(m[1], 10) : 1, newStart: m ? parseInt(m[2], 10) : 1 };
}

function buildRows(lines: string[]): DiffRow[] {
  const header = lines[0] ?? "";
  const { oldStart, newStart } = parseHunkHeader(header);
  let oldN = oldStart, newN = newStart;
  const rows: DiffRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newN++ });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({ kind: "del", text: line.slice(1), oldLine: oldN++, newLine: null });
    } else {
      rows.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine: oldN++, newLine: newN++ });
    }
  }
  pairReplaceBlocks(rows);
  return rows;
}

/** For maximal del-run immediately followed by add-run, index-pair and attach word-diff. */
function pairReplaceBlocks(rows: DiffRow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind === "del") {
      let d = i; while (d < rows.length && rows[d].kind === "del") d++;
      let a = d; while (a < rows.length && rows[a].kind === "add") a++;
      const dels = rows.slice(i, d), adds = rows.slice(d, a);
      const pairs = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        const wd = wordDiff(dels[k].text, adds[k].text);
        dels[k].segments = wd.old; adds[k].segments = wd.new;
      }
      i = a;
    } else i++;
  }
}
```
In `buildHunk`'s returned object add `rows: buildRows(lines)`.

- [ ] **Step 4: Fix the gutter deleted-line count** in `parseDiffForFile`. The current code emits a single `removed-after` marker per deletion run (`:165-167`, `:175-177`, `:184-186`). Add the run length so the gutter can show the true count. Change `DiffLineMarker` to include `count`:
```ts
export interface DiffLineMarker { line: number; kind: "added" | "removed-after"; count?: number; }
```
and at each flush site set `count: pendingRemovals` on the pushed `removed-after` marker. Update `editor/diffGutter.ts` to read `marker.count` for the deletion tooltip/visual (e.g. title `${count} line(s) removed`). Add a test:
```ts
import { parseDiffForFile } from "./diffParser";
it("removed-after marker carries the run length", () => {
  const diff = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,1 @@\n-a\n-b\n c\n`;
  const m = parseDiffForFile(diff, "x.ts").find(mk => mk.kind === "removed-after");
  expect(m?.count).toBe(2);
});
```

- [ ] **Step 5: Run tests — pass.**
- [ ] **Step 6: Commit.**
```bash
git add src/lib/diffParser.ts src/lib/diffParser.test.ts src/components/editor/diffGutter.ts
git commit -m "feat(g3): diffParser structured rows + line numbers + paired word-diff + gutter count fix"
```

---

## Task 6: Backend — `apply_hunk` + `ignore_whitespace` diff

**Files:**
- Modify: `src-tauri/src/git_ops.rs` (`get_diff_text` gains a bool)
- Modify: `src-tauri/src/commands.rs` (`get_git_diff` param; new `apply_hunk`)
- Modify: `src-tauri/src/lib.rs` (register `apply_hunk`)
- Modify: `src/lib/ipc.ts` (`getGitDiff` optional flag; new `applyHunk`)
- Test: `src-tauri/src/tests.rs` (apply_hunk round-trip)

- [ ] **Step 1: Write the failing Rust test** in `src-tauri/src/tests.rs`:
```rust
#[test]
fn apply_hunk_restores_a_reverted_change() {
    use std::fs;
    let dir = tempfile::tempdir().unwrap();
    crate::git_ops::init_repo(dir.path()).unwrap();
    fs::write(dir.path().join("a.txt"), "one\n").unwrap();
    // stage + commit baseline via git CLI for the test
    std::process::Command::new("git").args(["add","."]).current_dir(dir.path()).output().unwrap();
    std::process::Command::new("git").args(["-c","user.email=t@t","-c","user.name=t","commit","-m","x"]).current_dir(dir.path()).output().unwrap();
    fs::write(dir.path().join("a.txt"), "two\n").unwrap();
    let diff = crate::git_ops::get_diff_text(dir.path(), false).unwrap();
    // revert then re-apply
    tauri::async_runtime::block_on(crate::commands::revert_hunk(dir.path().to_string_lossy().into(), diff.clone())).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one\n");
    tauri::async_runtime::block_on(crate::commands::apply_hunk(dir.path().to_string_lossy().into(), diff)).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "two\n");
}
```

- [ ] **Step 2: Run it — fails** (`cd src-tauri && cargo test apply_hunk`): `get_diff_text` arity + no `apply_hunk`.

- [ ] **Step 3a: `get_diff_text` gains `ignore_whitespace`** in `git_ops.rs:353`. Change signature to `pub fn get_diff_text(path: &Path, ignore_whitespace: bool) -> AppResult<String>` and, where `DiffOptions` is built, add `if ignore_whitespace { opts.ignore_whitespace(true); }`. Update the two existing Rust tests (`:452`, `:469`) to pass `false`.

- [ ] **Step 3b: `get_git_diff` command** (`commands.rs:618`) — add an optional param:
```rust
#[tauri::command]
pub async fn get_git_diff(path: String, ignore_whitespace: Option<bool>) -> AppResult<String> {
    let path = expand_tilde(&path);
    crate::git_ops::get_diff_text(std::path::Path::new(&path), ignore_whitespace.unwrap_or(false))
}
```

- [ ] **Step 3c: `apply_hunk`** — clone `revert_hunk` (`commands.rs:1852`) without `--reverse`:
```rust
#[tauri::command]
pub async fn apply_hunk(workspace_path: String, hunk_text: String) -> AppResult<()> {
    use std::io::Write as _;
    use tempfile::NamedTempFile;
    let workspace_path = expand_tilde(&workspace_path);
    let mut tmp = NamedTempFile::new().map_err(|e| AppError::Other(format!("failed to create tempfile: {e}")))?;
    tmp.write_all(hunk_text.as_bytes()).map_err(|e| AppError::Other(format!("failed to write hunk: {e}")))?;
    tmp.flush().map_err(|e| AppError::Other(format!("failed to flush hunk: {e}")))?;
    let output = std::process::Command::new("git")
        .args(["apply", "-p1", tmp.path().to_str().unwrap_or("")])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git apply: {e}")))?;
    if !output.status.success() {
        return Err(AppError::Other(format!("git apply failed: {}", String::from_utf8_lossy(&output.stderr))));
    }
    Ok(())
}
```

- [ ] **Step 3d: Register** `commands::apply_hunk,` in the `lib.rs` invoke handler list (next to `revert_hunk` at `:214`).

- [ ] **Step 4: Run `cargo test` — pass.** (`cd src-tauri && cargo test`).

- [ ] **Step 5: Frontend IPC** in `src/lib/ipc.ts`: change `getGitDiff` (`:197`) and add `applyHunk` near `revertHunk` (`:258`):
```ts
getGitDiff: (path: string, ignoreWhitespace?: boolean) =>
  invoke<string>("get_git_diff", { path, ignoreWhitespace }),
applyHunk: (workspacePath: string, hunkText: string) =>
  invoke<void>("apply_hunk", { workspacePath, hunkText }),
```

- [ ] **Step 6: Verify + commit.**
```bash
npm run typecheck && cd src-tauri && cargo test && cd ..
git add src-tauri/src/git_ops.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/tests.rs src/lib/ipc.ts
git commit -m "feat(g3): backend apply_hunk (reject-undo) + ignore_whitespace diff"
```

---

## Task 7: `DiffLines.tsx` — inline rendering (syntax + word diff + gutters)

**Files:**
- Create: `src/components/review/DiffLines.tsx`
- Test: `src/components/review/DiffLines.test.tsx`

- [ ] **Step 1: Write the failing test.**
```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { DiffLines } from "./DiffLines";
import type { DiffRow } from "../../lib/diffParser";

const rows: DiffRow[] = [
  { kind: "context", text: "function greet() {", oldLine: 1, newLine: 1 },
  { kind: "del", text: '  return "Hi"', oldLine: 2, newLine: null, segments: [{kind:"equal",text:"  return "},{kind:"del",text:'"Hi"'}] },
  { kind: "add", text: "  return `Hello`", oldLine: null, newLine: 2, segments: [{kind:"equal",text:"  return "},{kind:"add",text:"`Hello`"}] },
];

describe("DiffLines inline", () => {
  it("renders a row per diff line with line numbers", () => {
    const { container } = render(<DiffLines rows={rows} filePath="src/a.ts" mode="inline" />);
    expect(container.querySelectorAll("[data-diff-row]").length).toBe(3);
    expect(container.textContent).toContain("function greet()");
  });
  it("applies add/del backgrounds", () => {
    const { container } = render(<DiffLines rows={rows} filePath="src/a.ts" mode="inline" />);
    expect(container.querySelector('[data-kind="add"]')).toBeTruthy();
    expect(container.querySelector('[data-kind="del"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement.** Render each row with a two-column line-number gutter (old|new), syntax-highlighted via `highlightLine`, with word-diff segment backgrounds layered for paired rows:
```tsx
import { highlightLine } from "../../lib/diffHighlight";
import type { DiffRow, WordSegment } from "../../lib/diffParser";
import type { ReadingMode } from "../../stores/reviewPrefsStore";

const ROW_BG: Record<string, string> = {
  add: "var(--verdigris-ghost)", del: "var(--rouge-ghost)", context: "transparent",
};
const ROW_FG = { add: "text-octo-verdigris", del: "text-octo-rouge", context: "text-octo-sage" } as const;

function renderText(row: DiffRow, filePath: string) {
  // Word-diff segments take precedence (highlight the changed spans); otherwise syntax-highlight.
  if (row.segments && row.segments.length > 0) {
    return row.segments.map((s: WordSegment, i) => (
      <span key={i} className={s.kind === "equal" ? "" : s.kind === "add" ? "wd-add" : "wd-del"}>{s.text}</span>
    ));
  }
  return highlightLine(row.text, filePath).map((tk, i) => (
    <span key={i} className={tk.cls}>{tk.text}</span>
  ));
}

export function DiffLines({ rows, filePath, mode }: { rows: DiffRow[]; filePath: string; mode: ReadingMode }) {
  if (mode === "sbs") return <SideBySide rows={rows} filePath={filePath} />; // implemented in Task 12
  return (
    <pre className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      {rows.map((row, i) => (
        <div key={i} data-diff-row data-kind={row.kind} className={`flex ${ROW_FG[row.kind]}`} style={{ background: ROW_BG[row.kind] }}>
          <span aria-hidden className="select-none px-2 text-right text-octo-mute" style={{ minWidth: 36 }}>{row.oldLine ?? ""}</span>
          <span aria-hidden className="select-none px-2 text-right text-octo-mute" style={{ minWidth: 36 }}>{row.newLine ?? ""}</span>
          <span className="select-none pr-1 text-octo-mute">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
          <code className="flex-1 whitespace-pre pr-3">{renderText(row, filePath)}</code>
        </div>
      ))}
    </pre>
  );
}

// Placeholder until Task 12; keeps the module compiling.
function SideBySide({ rows, filePath }: { rows: DiffRow[]; filePath: string }) {
  return <DiffLines rows={rows} filePath={filePath} mode="inline" />;
}
```
Add the word-diff segment background classes to `styles.css`:
```css
.wd-add { background: rgba(143, 201, 168, 0.30); border-radius: 2px; }
.wd-del { background: rgba(209, 139, 139, 0.28); border-radius: 2px; }
```
(Define these as tokens `--verdigris-strong`/`--rouge-strong` if you prefer; either is acceptable since they're new design tokens, but keep them in `styles.css`, not inline.)

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/DiffLines.tsx src/components/review/DiffLines.test.tsx src/styles.css
git commit -m "feat(g3): DiffLines — inline syntax + word-diff rendering"
```

---

## Task 8: `HunkRail.tsx` — sticky brass rail with actions + focus

**Files:**
- Create: `src/components/review/HunkRail.tsx`
- Test: `src/components/review/HunkRail.test.tsx`

- [ ] **Step 1: Write the failing test.**
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { HunkRail } from "./HunkRail";

describe("HunkRail", () => {
  const base = { range: "lines 1–4", additions: 2, deletions: 1, focused: false, staged: false };
  it("calls onAccept", () => {
    const onAccept = vi.fn();
    const { getByRole } = render(<HunkRail {...base} onAccept={onAccept} onReject={() => {}} onWhy={() => {}} />);
    fireEvent.click(getByRole("button", { name: /accept/i }));
    expect(onAccept).toHaveBeenCalled();
  });
  it("shows staged + hides actions when staged", () => {
    const { queryByRole, container } = render(<HunkRail {...base} staged onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} />);
    expect(queryByRole("button", { name: /accept/i })).toBeNull();
    expect(container.textContent?.toLowerCase()).toContain("staged");
  });
  it("focused adds the bright rule data attr", () => {
    const { container } = render(<HunkRail {...base} focused onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} />);
    expect(container.querySelector('[data-focused="true"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement** (brass left rule via `border-l`, dim when staged, bright when focused; the `⟶` glyph):
```tsx
import { CheckCircle, XCircle, HelpCircle } from "lucide-react";

interface Props {
  range: string; additions: number; deletions: number;
  focused: boolean; staged: boolean;
  onAccept: () => void; onReject: () => void; onWhy: () => void;
}

export function HunkRail({ range, additions, deletions, focused, staged, onAccept, onReject, onWhy }: Props) {
  return (
    <div
      data-focused={focused}
      className="sticky top-0 z-10 flex items-center gap-2 border-l-2 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.12em] backdrop-blur-sm"
      style={{
        borderLeftColor: focused ? "var(--brass-dim)" : "rgba(212,165,116,0.18)",
        background: focused ? "var(--brass-faint)" : "var(--octo-onyx-40, rgba(12,10,8,0.4))",
        opacity: staged ? 0.55 : 1,
      }}
    >
      <span className="text-octo-mute">{focused ? "⟶ " : ""}{range}{staged ? " · staged ✓" : ""}</span>
      <span className="ml-auto flex items-center gap-2">
        {additions > 0 && <span className="text-octo-verdigris">+{additions}</span>}
        {deletions > 0 && <span className="text-octo-rouge">−{deletions}</span>}
        {!staged && (
          <>
            <button onClick={onWhy} className="rounded px-1.5 py-0.5 text-octo-mute hover:text-octo-sage focus-visible:ring-1 focus-visible:ring-octo-brass">
              <HelpCircle size={11} className="inline" /> Why?
            </button>
            <button onClick={onReject} aria-label="Reject hunk" className="rounded px-1.5 py-0.5 text-octo-sage hover:text-octo-rouge focus-visible:ring-1 focus-visible:ring-octo-brass">
              <XCircle size={11} className="inline" /> Reject
            </button>
            <button onClick={onAccept} aria-label="Accept hunk" className="rounded px-2 py-0.5 text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}>
              <CheckCircle size={11} className="inline" /> Accept
            </button>
          </>
        )}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/HunkRail.tsx src/components/review/HunkRail.test.tsx
git commit -m "feat(g3): HunkRail — sticky brass hunk rail with actions + focus/staged states"
```

---

## Task 9: `FileDiffSection.tsx` — header, viewed/collapse, hunks, reject-undo

**Files:**
- Create: `src/components/review/FileDiffSection.tsx`
- Test: `src/components/review/FileDiffSection.test.tsx`

- [ ] **Step 1: Write the failing test.**
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { FileDiffSection } from "./FileDiffSection";
import type { DiffFile } from "../../lib/diffParser";

const file: DiffFile = {
  filePath: "src/a.ts", changeType: "modified", fileHeader: "",
  hunks: [{ header: "@@ -1,1 +1,1 @@", lines: ["@@ -1,1 +1,1 @@","-a","+b"], rawText: "x", additions: 1, deletions: 1,
    rows: [{ kind: "del", text: "a", oldLine: 1, newLine: null }, { kind: "add", text: "b", oldLine: null, newLine: 1 }] }],
};

describe("FileDiffSection", () => {
  it("shows the file header with type + path", () => {
    const { getByText } = render(<FileDiffSection file={file} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(getByText("MODIFIED")).toBeTruthy();
    expect(getByText("src/a.ts")).toBeTruthy();
  });
  it("collapses content when viewed", () => {
    const { container } = render(<FileDiffSection file={file} focusedHunk={-1} viewed collapsed
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(container.querySelector("[data-diff-row]")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement.** Header carries the type badge (reuse the existing `typeLabel`/`typeColor` logic from the old `FileDiffSection` at `ReviewCanvas.tsx:647-660`, plus a rename note when `changeType` indicates a rename — for now `modified`/`new`/`deleted`), a "viewed ✓" toggle, and per-hunk `HunkRail` + `DiffLines`. Use the grid-rows `0fr↔1fr` collapse idiom. Keep an internal `rejectedUndo` list: when a hunk is rejected, render a slim inline "Hunk rejected · Undo" bar for 6s (undo calls the passed `onUndoReject(rawText)`), then call `onReject` to remove it:
```tsx
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { HunkRail } from "./HunkRail";
import { DiffLines } from "./DiffLines";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";
import type { DiffFile } from "../../lib/diffParser";

interface Props {
  file: DiffFile; focusedHunk: number; viewed: boolean; collapsed: boolean;
  onAccept: (hunkIdx: number) => void;
  onReject: (hunkIdx: number) => void;
  onWhy: (hunkIdx: number) => void;
  onToggleViewed: () => void;
  onToggleCollapsed: () => void;
}

export function FileDiffSection({ file, focusedHunk, viewed, collapsed, onAccept, onReject, onWhy, onToggleViewed, onToggleCollapsed }: Props) {
  const mode = useReviewPrefs((s) => s.readingMode);
  const [staged] = useState<Set<number>>(new Set());
  const typeLabel = file.changeType === "new" ? "NEW" : file.changeType === "deleted" ? "DELETED" : "MODIFIED";
  const typeColor = file.changeType === "new" ? "text-octo-verdigris" : file.changeType === "deleted" ? "text-octo-rouge" : "text-octo-brass";
  const id = `review-file-${encodeURIComponent(file.filePath)}`;
  return (
    <div className="scroll-mt-4" id={id}>
      <div className="flex items-center gap-2 border-b border-octo-hairline pb-1.5">
        <span className={`font-mono text-[9px] font-semibold uppercase tracking-[0.2em] ${typeColor}`}>{typeLabel}</span>
        <span className="text-octo-hairline">·</span>
        <span className="font-mono text-[12.5px] text-octo-ivory">{file.filePath}</span>
        <ChevronRight size={11} className="text-octo-mute" />
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">{file.hunks.length} hunk{file.hunks.length !== 1 ? "s" : ""}</span>
        <button onClick={onToggleViewed}
          className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] focus-visible:ring-1 focus-visible:ring-octo-brass ${viewed ? "text-octo-verdigris" : "text-octo-mute hover:text-octo-sage"}`}>
          {viewed ? "✓ viewed" : "mark viewed"}
        </button>
      </div>
      <div className="grid transition-[grid-template-rows] duration-[var(--dur-standard)]" style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}>
        <div className="min-h-0 overflow-hidden">
          {file.hunks.map((hunk, i) => (
            <div key={i} className="mt-3">
              <HunkRail range={fmtRange(hunk.header)} additions={hunk.additions} deletions={hunk.deletions}
                focused={focusedHunk === i} staged={staged.has(i)}
                onAccept={() => onAccept(i)} onReject={() => onReject(i)} onWhy={() => onWhy(i)} />
              <DiffLines rows={hunk.rows} filePath={file.filePath} mode={mode} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function fmtRange(header: string): string {
  const m = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return header;
  const oEnd = parseInt(m[1],10) + (parseInt(m[2]||"1",10)-1);
  const nEnd = parseInt(m[3],10) + (parseInt(m[4]||"1",10)-1);
  return `lines ${m[1]}–${oEnd} → ${m[3]}–${nEnd}`;
}
```
(The reject-undo inline bar + `onUndoReject` wiring is finalized in Task 13 where `ReviewCanvas` owns the staged set and undo via `ipc.applyHunk`; here keep the prop surface minimal and tested.)

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/FileDiffSection.tsx src/components/review/FileDiffSection.test.tsx
git commit -m "feat(g3): FileDiffSection — header, viewed/collapse, hunk rails + lines"
```

---

## Task 10: `useDiffKeyboard.ts` — focus model + dispatch

**Files:**
- Create: `src/components/review/useDiffKeyboard.ts`
- Test: `src/components/review/useDiffKeyboard.test.ts`

- [ ] **Step 1: Write the failing test** (test the pure reducer that maps a key to a focus change/action — keep DOM listeners thin):
```ts
import { describe, it, expect } from "vitest";
import { nextFocus, type FlatHunk } from "./useDiffKeyboard";

const flat: FlatHunk[] = [
  { fileIdx: 0, hunkIdx: 0 }, { fileIdx: 0, hunkIdx: 1 }, { fileIdx: 1, hunkIdx: 0 },
];

describe("nextFocus", () => {
  it("j advances, clamps at end", () => {
    expect(nextFocus(flat, 0, "j")).toBe(1);
    expect(nextFocus(flat, 2, "j")).toBe(2);
  });
  it("k retreats, clamps at 0", () => {
    expect(nextFocus(flat, 1, "k")).toBe(0);
    expect(nextFocus(flat, 0, "k")).toBe(0);
  });
  it("] jumps to first hunk of next file", () => {
    expect(nextFocus(flat, 0, "]")).toBe(2); // file 0 -> file 1's first hunk
  });
  it("[ jumps to first hunk of prev file", () => {
    expect(nextFocus(flat, 2, "[")).toBe(0);
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement** the pure helper + a hook that binds keys (only when the diff container has focus and the editor doesn't):
```ts
import { useEffect } from "react";

export interface FlatHunk { fileIdx: number; hunkIdx: number; }
export type NavKey = "j" | "k" | "]" | "[";

export function nextFocus(flat: FlatHunk[], current: number, key: NavKey): number {
  if (flat.length === 0) return -1;
  const cur = Math.max(0, Math.min(current, flat.length - 1));
  if (key === "j") return Math.min(cur + 1, flat.length - 1);
  if (key === "k") return Math.max(cur - 1, 0);
  const curFile = flat[cur]?.fileIdx ?? 0;
  if (key === "]") { const i = flat.findIndex(f => f.fileIdx > curFile); return i === -1 ? cur : i; }
  // "["
  const firstOfCur = flat.findIndex(f => f.fileIdx === curFile);
  if (firstOfCur > 0) { const prevFile = flat[firstOfCur - 1].fileIdx; return flat.findIndex(f => f.fileIdx === prevFile); }
  return cur;
}

export interface DiffKeyboardActions {
  accept: () => void; reject: () => void; acceptFile: () => void;
  toggleViewed: () => void; open: () => void; why: () => void;
  toggleCollapse: () => void; focusFilter: () => void; focusCommit: () => void; toggleHelp: () => void;
}

export function useDiffKeyboard(opts: {
  enabled: boolean; flat: FlatHunk[]; focused: number;
  setFocused: (n: number) => void; actions: DiffKeyboardActions; containerRef: React.RefObject<HTMLElement>;
}) {
  const { enabled, flat, focused, setFocused, actions, containerRef } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = containerRef.current;
      if (!el || !el.contains(document.activeElement) && document.activeElement !== document.body) return;
      const target = e.target as HTMLElement;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const k = e.key;
      const navMap: Record<string, NavKey> = { j: "j", ArrowDown: "j", k: "k", ArrowUp: "k", "]": "]", "[": "[" };
      if (k in navMap) { e.preventDefault(); setFocused(nextFocus(flat, focused, navMap[k])); return; }
      const map: Record<string, () => void> = {
        a: actions.accept, x: actions.reject, A: actions.acceptFile, v: actions.toggleViewed,
        o: actions.open, w: actions.why, " ": actions.toggleCollapse, "/": actions.focusFilter,
        c: actions.focusCommit, "?": actions.toggleHelp,
      };
      if (k in map) { e.preventDefault(); map[k](); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, flat, focused, setFocused, actions, containerRef]);
}
```

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/useDiffKeyboard.ts src/components/review/useDiffKeyboard.test.ts
git commit -m "feat(g3): useDiffKeyboard — hunk focus model + keyboard dispatch"
```

---

## Task 11: `DiffView.tsx` — container + anchor selection + keyboard host

**Files:**
- Create: `src/components/review/DiffView.tsx`
- Test: `src/components/review/DiffView.test.tsx`

- [ ] **Step 1: Write the failing test.**
```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { DiffFile } from "../../lib/diffParser";

const files: DiffFile[] = [{
  filePath: "src/a.ts", changeType: "modified", fileHeader: "",
  hunks: [{ header: "@@ -1 +1 @@", lines: [], rawText: "x", additions: 1, deletions: 0,
    rows: [{ kind: "add", text: "b", oldLine: null, newLine: 1 }] }],
}];

describe("DiffView", () => {
  it("renders a section per file", () => {
    const { getByText } = render(<DiffView files={files} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText("src/a.ts")).toBeTruthy();
  });
  it("renders empty state with no files", () => {
    const { getByText } = render(<DiffView files={[]} stagedCount={2} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText(/staged/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement** the container: builds the flat hunk list, holds `focused` + per-file `viewed`/`collapsed` maps, hosts `useDiffKeyboard`, renders `FileDiffSection`s + `EmptyDiffState`, and exposes line-anchor selection state (`anchor`) + an optional `anchorSlot` render prop (the G5 hook). Wire keyboard actions to the focused hunk:
```tsx
import { useMemo, useRef, useState } from "react";
import { FileDiffSection } from "./FileDiffSection";
import { EmptyDiffState } from "./EmptyDiffState";
import { useDiffKeyboard, type FlatHunk } from "./useDiffKeyboard";
import type { DiffFile } from "../../lib/diffParser";

export interface DiffAnchor { filePath: string; startLine: number; endLine: number; }

interface Props {
  files: DiffFile[]; workspacePath: string; stagedCount?: number;
  onAccept: (filePath: string, hunkIdx: number) => void;
  onReject: (filePath: string, hunkIdx: number) => void;
  onWhy: (filePath: string, hunkIdx: number) => void;
  onOpen: (filePath: string, line: number) => void;
  onViewedChange?: (filePath: string, viewed: boolean) => void;
  onFocusFilter?: () => void; onFocusCommit?: () => void;
  anchorSlot?: (anchor: DiffAnchor, clear: () => void) => React.ReactNode;
}

export function DiffView(props: Props) {
  const { files, stagedCount = 0 } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(0);
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [help, setHelp] = useState(false);
  const [anchor, setAnchor] = useState<DiffAnchor | null>(null);

  const flat: FlatHunk[] = useMemo(
    () => files.flatMap((f, fi) => f.hunks.map((_, hi) => ({ fileIdx: fi, hunkIdx: hi }))),
    [files],
  );
  const cur = flat[focused];
  const curFile = cur ? files[cur.fileIdx] : undefined;

  const toggleViewed = (path: string) => {
    const v = !viewed[path];
    setViewed((m) => ({ ...m, [path]: v }));
    setCollapsed((m) => ({ ...m, [path]: v }));
    props.onViewedChange?.(path, v);
  };

  useDiffKeyboard({
    enabled: files.length > 0, flat, focused, setFocused, containerRef,
    actions: {
      accept: () => cur && props.onAccept(files[cur.fileIdx].filePath, cur.hunkIdx),
      reject: () => cur && props.onReject(files[cur.fileIdx].filePath, cur.hunkIdx),
      acceptFile: () => curFile && curFile.hunks.forEach((_, hi) => props.onAccept(curFile.filePath, hi)),
      toggleViewed: () => curFile && toggleViewed(curFile.filePath),
      open: () => cur && props.onOpen(files[cur.fileIdx].filePath, firstChangedLine(files[cur.fileIdx], cur.hunkIdx)),
      why: () => cur && props.onWhy(files[cur.fileIdx].filePath, cur.hunkIdx),
      toggleCollapse: () => curFile && setCollapsed((m) => ({ ...m, [curFile.filePath]: !m[curFile.filePath] })),
      focusFilter: () => props.onFocusFilter?.(),
      focusCommit: () => props.onFocusCommit?.(),
      toggleHelp: () => setHelp((h) => !h),
    },
  });

  if (files.length === 0) return <EmptyDiffState stagedCount={stagedCount} />;

  return (
    <div ref={containerRef} tabIndex={0} className="octo-fade-in absolute inset-0 overflow-y-auto outline-none" role="region" aria-label="Diff">
      <div className="space-y-6 px-4 py-4">
        {files.map((file, fi) => (
          <FileDiffSection key={file.filePath} file={file}
            focusedHunk={cur?.fileIdx === fi ? cur.hunkIdx : -1}
            viewed={!!viewed[file.filePath]} collapsed={!!collapsed[file.filePath]}
            onAccept={(hi) => props.onAccept(file.filePath, hi)}
            onReject={(hi) => props.onReject(file.filePath, hi)}
            onWhy={(hi) => props.onWhy(file.filePath, hi)}
            onToggleViewed={() => toggleViewed(file.filePath)}
            onToggleCollapsed={() => setCollapsed((m) => ({ ...m, [file.filePath]: !m[file.filePath] }))} />
        ))}
      </div>
      {help && <KeyboardHelp onClose={() => setHelp(false)} />}
      {anchor && props.anchorSlot?.(anchor, () => setAnchor(null))}
    </div>
  );
}

function firstChangedLine(file: DiffFile, hunkIdx: number): number {
  const r = file.hunks[hunkIdx]?.rows.find((row) => row.kind !== "context");
  return r?.newLine ?? r?.oldLine ?? 1;
}

function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="octo-fade-in fixed bottom-4 right-4 z-50 rounded-md border border-octo-hairline bg-octo-panel p-3 font-mono text-[10px] text-octo-sage shadow-2xl" role="dialog" aria-label="Keyboard shortcuts">
      <div className="mb-1 text-octo-brass">Keyboard · press ? to close</div>
      <div>j/k move · ]/[ file · Space fold · a accept · x reject · A file · v viewed · o open · w why · c commit</div>
      <button onClick={onClose} className="sr-only">Close</button>
    </div>
  );
}
```
(Anchor selection via shift-click on line numbers is wired into `DiffLines` setting `onAnchor`; for this task ship the `anchorSlot` plumbing — the selection handler can be added when G5 needs it. The `anchor` state + slot are the primitive.)

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/DiffView.tsx src/components/review/DiffView.test.tsx
git commit -m "feat(g3): DiffView — container, focus state, keyboard host, viewed/collapse, anchor slot"
```

---

## Task 12: Side-by-side mode in `DiffLines`

**Files:**
- Modify: `src/components/review/DiffLines.tsx` (replace the `SideBySide` placeholder)
- Test: `src/components/review/DiffLines.test.tsx` (add SBS cases)

- [ ] **Step 1: Add failing test.**
```tsx
it("side-by-side renders two columns", () => {
  const { container } = render(<DiffLines rows={rows} filePath="src/a.ts" mode="sbs" />);
  expect(container.querySelectorAll("[data-sbs-col]").length).toBe(2);
});
it("side-by-side pads unbalanced replace blocks", () => {
  const unbal: DiffRow[] = [
    { kind: "del", text: "x", oldLine: 1, newLine: null },
    { kind: "add", text: "y", oldLine: null, newLine: 1 },
    { kind: "add", text: "z", oldLine: null, newLine: 2 },
  ];
  const { container } = render(<DiffLines rows={unbal} filePath="a.ts" mode="sbs" />);
  // old column shows one real row + one pad; new column shows two
  const cols = container.querySelectorAll("[data-sbs-col]");
  expect(cols[0].querySelectorAll("[data-diff-row]").length).toBe(cols[1].querySelectorAll("[data-diff-row]").length);
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement** `SideBySide`: build aligned left (old) / right (new) row lists. Context rows mirror on both sides. Replace blocks (del-run + add-run) align index-wise; pad the shorter side with empty rows so both columns have equal length:
```tsx
function SideBySide({ rows, filePath }: { rows: DiffRow[]; filePath: string }) {
  const left: (DiffRow | null)[] = [];
  const right: (DiffRow | null)[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "context") { left.push(r); right.push(r); i++; continue; }
    let d = i; while (d < rows.length && rows[d].kind === "del") d++;
    let a = d; while (a < rows.length && rows[a].kind === "add") a++;
    const dels = rows.slice(i, d), adds = rows.slice(d, a);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) { left.push(dels[k] ?? null); right.push(adds[k] ?? null); }
    i = a;
  }
  return (
    <div className="flex overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      <Col rows={left} side="old" filePath={filePath} />
      <div className="w-px shrink-0 bg-octo-hairline" />
      <Col rows={right} side="new" filePath={filePath} />
    </div>
  );
}

function Col({ rows, side, filePath }: { rows: (DiffRow | null)[]; side: "old" | "new"; filePath: string }) {
  return (
    <div data-sbs-col className="min-w-0 flex-1">
      {rows.map((row, i) => {
        if (!row) return <div key={i} data-diff-row className="h-[1.55em] bg-octo-onyx/30" aria-hidden />;
        const bg = row.kind === "add" ? "var(--verdigris-ghost)" : row.kind === "del" ? "var(--rouge-ghost)" : "transparent";
        const ln = side === "old" ? row.oldLine : row.newLine;
        return (
          <div key={i} data-diff-row data-kind={row.kind} className="flex whitespace-pre" style={{ background: bg }}>
            <span aria-hidden className="select-none px-2 text-right text-octo-mute" style={{ minWidth: 36 }}>{ln ?? ""}</span>
            <code className="flex-1 pr-3">{renderText(row, filePath)}</code>
          </div>
        );
      })}
    </div>
  );
}
```
(`renderText` is the helper from Task 7 — keep it module-scoped so both inline and SBS share it.)

- [ ] **Step 4: Run tests — pass.**
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/DiffLines.tsx src/components/review/DiffLines.test.tsx
git commit -m "feat(g3): DiffLines — side-by-side mode with padded replace-block alignment"
```

---

## Task 13: `ReviewCanvas` shell rewrite + `App.tsx` wiring + reject-undo

**Files:**
- Modify: `src/components/ReviewCanvas.tsx` (replace the diff-view internals with `DiffView`; add toolbar toggles; own staged set + undo)
- Modify: `src/App.tsx` (pass `readingMode`/`ignoreWhitespace`; forward intents)
- Test: `src/components/ReviewCanvas.test.tsx` (toolbar toggles + undo)

- [ ] **Step 1: Write failing tests** for the toolbar (inline/SBS toggle drives the store, whitespace toggle drives the store):
```tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ReviewCanvas } from "./ReviewCanvas";
import { useReviewPrefs } from "../stores/reviewPrefsStore";

beforeEach(() => useReviewPrefs.setState({ readingMode: "inline", ignoreWhitespace: false }));

describe("ReviewCanvas toolbar", () => {
  const base = { workspaceId: "w", workspacePath: "/w", gitStatus: null, gitDiff: "" };
  it("SBS toggle sets the store", () => {
    const { getByRole } = render(<ReviewCanvas {...base} />);
    fireEvent.click(getByRole("button", { name: /side.?by.?side/i }));
    expect(useReviewPrefs.getState().readingMode).toBe("sbs");
  });
  it("whitespace toggle sets the store", () => {
    const { getByRole } = render(<ReviewCanvas {...base} />);
    fireEvent.click(getByRole("button", { name: /whitespace/i }));
    expect(useReviewPrefs.getState().ignoreWhitespace).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Rewrite `ReviewCanvas`.** Keep the existing props (`Props` at `ReviewCanvas.tsx:29-45`) and toolbar structure (`:470-575`), but: (a) add an **inline/SBS** segmented toggle and a **whitespace** toggle driven by `useReviewPrefs`; (b) replace the diff `viewMode === "diff"` body (`:580-603`) with `<DiffView .../>`; (c) own a per-file `staged` set + reject-undo using `ipc.applyHunk`. New imports: `import { DiffView } from "./review/DiffView";`, `import { parseFullDiff } from "../lib/diffParser";`, `import { useReviewPrefs } from "../stores/reviewPrefsStore";`. Accept/Reject/Why/Open handlers:
```tsx
const accept = async (filePath: string, hunkIdx: number) => {
  const hunk = diffFiles.find(f => f.filePath === filePath)?.hunks[hunkIdx];
  if (!hunk) return;
  try { await ipc.stageHunk(workspacePath, hunk.rawText); onDiffChange?.(); }
  catch (e) { console.error("stage hunk failed:", e); }
};
const reject = async (filePath: string, hunkIdx: number) => {
  const hunk = diffFiles.find(f => f.filePath === filePath)?.hunks[hunkIdx];
  if (!hunk) return;
  try {
    await ipc.revertHunk(workspacePath, hunk.rawText);
    pushToast({ level: "info", title: "Hunk rejected", body: "Undo", timeout: 6000,
      action: { label: "Undo", onClick: () => ipc.applyHunk(workspacePath, hunk.rawText).then(() => onDiffChange?.()) } });
    onDiffChange?.();
  } catch (e) { console.error("revert hunk failed:", e); }
};
```
If the `Toast` type has no `action`, instead implement the undo as a transient inline bar in `FileDiffSection` (pass an `onReject` that records the rawText and shows the bar). **Decision for this plan:** use the inline-bar approach to avoid editing the shared `Toasts.tsx` (keeps G3 self-contained). Add to `FileDiffSection` a local `rejected: { idx, rawText }[]` and render a slim bar `Hunk rejected · Undo` (Undo → `props.onUndoReject(rawText)`, then drop the entry); `ReviewCanvas` passes `onUndoReject={(raw) => ipc.applyHunk(workspacePath, raw).then(() => onDiffChange?.())}`. Update `FileDiffSection` props + test accordingly.

Toolbar additions (place beside the existing Diff/Editor toggle):
```tsx
const { readingMode, ignoreWhitespace, setReadingMode, setIgnoreWhitespace } = useReviewPrefs();
// inline/SBS segmented control (only visible in diff view)
{viewMode === "diff" && (
  <div className="flex items-center rounded-md border border-octo-hairline overflow-hidden">
    <button aria-label="Inline diff" onClick={() => setReadingMode("inline")}
      className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] ${readingMode === "inline" ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"}`}
      style={readingMode === "inline" ? { background: "var(--brass-ghost)" } : undefined}>Inline</button>
    <button aria-label="Side-by-side diff" onClick={() => setReadingMode("sbs")}
      className={`border-l border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] ${readingMode === "sbs" ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"}`}
      style={readingMode === "sbs" ? { background: "var(--brass-ghost)" } : undefined}>Split</button>
  </div>
)}
{viewMode === "diff" && (
  <button aria-label="Ignore whitespace" onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
    className={`rounded-md border border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] ${ignoreWhitespace ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"}`}
    style={ignoreWhitespace ? { background: "var(--brass-ghost)" } : undefined}>±WS</button>
)}
```
Replace the diff body:
```tsx
{viewMode === "diff" && (
  <DiffView files={diffFiles} workspacePath={workspacePath}
    stagedCount={gitStatus?.changedFiles.filter(f => f.staged).length ?? 0}
    onAccept={accept} onReject={reject}
    onWhy={(filePath) => {/* keep existing Why? — open the file's agent-origin drawer; reuse listFileEdits/getMessage */}}
    onOpen={(filePath, line) => onOpenFileAtLine?.(filePath, line)}
    onViewedChange={onViewedChange} onFocusFilter={onFocusFilter} onFocusCommit={onFocusCommit} />
)}
```
Add the new optional callback props to `Props` (`onOpenFileAtLine?`, `onViewedChange?`, `onFocusFilter?`, `onFocusCommit?`) — all optional so existing call sites keep compiling.

- [ ] **Step 4: Wire `App.tsx`.** At the `ReviewCanvas` usage (`App.tsx:1436-1465`): pass `onOpenFileAtLine={(p, line) => navigateToFile(p, "editor")}` (line param accepted for future precision), `onFocusCommit={() => {/* focus commit textarea in ChangesPanel — emit via a ref or existing mechanism */}}`, `onFocusFilter={() => {/* focus the ChangesPanel filter if present */}}`. Also make the diff fetch honor `ignoreWhitespace`: in the git-status effect where `ipc.getGitDiff(path)` is called for review (`App.tsx:513` region + `:1423`/`:1448`), read `useReviewPrefs.getState().ignoreWhitespace` and pass it: `ipc.getGitDiff(path, useReviewPrefs.getState().ignoreWhitespace)`, and re-fetch when it changes (subscribe to the store or add it to the effect deps). Keep edits additive and minimal.

- [ ] **Step 5: Run tests + typecheck — pass.** Update any existing `ReviewCanvas` test that asserted the old card DOM.
- [ ] **Step 6: Commit.**
```bash
npm run typecheck && npx vitest run
git add src/components/ReviewCanvas.tsx src/components/review/FileDiffSection.tsx src/components/review/FileDiffSection.test.tsx src/App.tsx src/components/ReviewCanvas.test.tsx
git commit -m "feat(g3): ReviewCanvas shell — inline/SBS+whitespace toggles, DiffView, reject-undo; App wiring"
```

---

## Task 14: Motion, a11y polish + full verification

**Files:**
- Modify: `src/components/review/*` (motion classes, focus rings, aria), `src/App.tsx` (crossfade on Diff⇄Editor)

- [ ] **Step 1: Motion.** Ensure the Diff⇄Editor and inline⇄SBS content swaps crossfade with `.octo-fade-in` (the `DiffView` root already has it; add a `key={viewMode}`/`key={readingMode}` wrapper in `ReviewCanvas` content so React remounts → crossfades). Verify no abrupt mounts: the Why? drawer (carried into the new flow) uses `.octo-fade-in`; the test drawer uses `.octo-rise-in` (Task 1).

- [ ] **Step 2: A11y.** Confirm every interactive control in `review/*` has `aria-label` + `focus-visible:ring-1 focus-visible:ring-octo-brass`; the diff container is focusable (`tabIndex={0}`, `role="region"`); the keyboard help is reachable via `?`. Add `prefers-reduced-motion` is already globally handled (styles.css) — no per-component work.

- [ ] **Step 3: Full verification.**
```bash
npm run typecheck && npx vitest run && (cd src-tauri && cargo test)
git diff feat/review-mode -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo "hex clean"
```
Expected: typecheck clean, all frontend tests green, Rust tests green, hex grep clean (the only inline rgba left are the documented `.wd-*`/atelierTheme mirrors).

- [ ] **Step 4: Rebuild the app to smoke-test** (per the cache gotcha):
```bash
rm -rf dist src-tauri/target/release/bundle && touch src-tauri/src/lib.rs
npm run tauri:build 2>&1 | tail -5
```
Manually verify in the `.app`: continuous diff with syntax highlight + word-diff; brass hunk rail; j/k/]/[ navigation; a/x with undo; v viewed/collapse; inline⇄split toggle persists; ±WS toggle re-fetches; test drawer output selectable.

- [ ] **Step 5: Commit + update tracker.**
```bash
git add -A && git commit -m "polish(g3): motion + a11y across review surfaces; verification"
```
Then on `feat/review-mode` update the Status Index row for G3 → `in progress`/`done` with the impl branch, and when merged set `done (merged to trunk)`.

---

## Self-Review (planning)

- **Spec coverage:** §2 paradigm C → Tasks 7–9,11; §3 reading modes → Tasks 7,12 + store Task 2; §6 syntax → Task 4; word-diff → Tasks 3,5; §7 keyboard → Task 10; collapse/viewed → Tasks 9,11; §10 anchor primitive → Task 11 (`anchorSlot`); §11 backend → Task 6; §12 Tier-0 → Task 1; rename display → Task 9 header (type badge; true rename detection deferred to G4's status work — noted); test-runner polish → Task 1 (selectable) ; gutter fix → Task 5; motion/a11y → Task 14.
- **Type consistency:** `DiffRow`/`WordSegment`/`DiffHunk.rows` defined in Tasks 3+5 and consumed in 7,9,11,12; `FlatHunk`/`nextFocus` in Task 10 used in 11; `ReadingMode` from Task 2 used in 7,12,13; `applyHunk`/`getGitDiff(…, ignoreWhitespace)` from Task 6 used in 13.
- **Independence:** only additive touches to shared substrates — `commands.rs`/`lib.rs` (new `apply_hunk` + param), `styles.css` (tokens/classes), `App.tsx` (optional props). No edits to `ChangesPanel.tsx` (G4), editor engine (G1), or AI (G5). `getGitStatus`/staging IPC reused as-is.
- **Known deferral:** true git rename detection display depends on richer `GitStatus` (G4/backend) — Task 9 shows the change-type badge; a `RENAMED` badge is a one-line add once status exposes it. Reject-undo uses the inline-bar approach to avoid touching shared `Toasts.tsx`.
