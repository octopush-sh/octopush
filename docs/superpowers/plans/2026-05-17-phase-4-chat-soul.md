# Phase 4 — Chat Soul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the chat surface from "generic AI tool" (rounded bubbles, purple accents, amber tool icons) to the editorial Atelier voice: model responses lead with a Spectral italic "key phrase" followed by sans body, tool calls render as marginalia (`§ READ` brass mono labels with a brass-dim left border), user turns are eyebrow-and-content (no bubble), and every secondary surface in the chat view (send button, working indicator, error, empty state) speaks Onyx & Brass.

**Architecture:** A pure key-phrase parser at `src/lib/parseKeyPhrase.ts` (testable in isolation). `ChatMessage.tsx` rewritten — user turns become "— You" eyebrow + sans content; assistant turns get the eyebrow `— Claude · Model`, then `parseKeyPhrase` splits the markdown content into lead sentence (italic serif) + body (sans, markdown-rendered with the new design system). `ToolCallCard.tsx` rewritten — same expand/collapse behavior but with `§ TOOL_NAME` mono brass label, brass-dim left border, brass-ghost fill, no unicode glyphs. `ChatView.tsx` reworked input bar (italic-serif placeholder, brass send arrow), streaming indicator (italic serif "Thinking…"), error treatment (brass-rule + ivory headline), empty state (rule + ceremonial copy). Finally, any leftover `console.log`/`debug:` artifacts from the previous fix cycle get removed.

**Tech stack:** React 19, Vitest, Tailwind v4 with Onyx & Brass tokens shipped in Phase 1, Spectral italic via Google Fonts, react-markdown for body rendering.

---

## Spec reference

Source of truth: `docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md` §4.3 (Workspace · Talk · hero), §5.2 (key-phrase fade-in animation), §6 (signature moments — `&`, `⟶`, `§`, italic-serif phrases).

The cheatsheet at `docs/design-system.md` has the component recipes used below. The `§` tool-card pattern is one of the five signature moments and must be preserved exactly.

---

## File structure

**Created**

| Path | Responsibility |
|------|----------------|
| `src/lib/parseKeyPhrase.ts` | Pure parser: split assistant text into `{ keyPhrase: string \| null; body: string }`. Handles edge cases (starts with code block, no sentence-ending punctuation, very short responses). |
| `src/lib/parseKeyPhrase.test.ts` | Vitest tests covering ~10 cases. |

**Modified (substantial rewrite)**

| Path | Why |
|------|-----|
| `src/components/ChatMessage.tsx` | Replace chat-bubble layout with eyebrow-and-content. Assistant lead sentence uses Spectral italic. Markdown components map updated to Onyx & Brass tokens (replace every `bg-zinc-*`, `text-zinc-*`, `bg-octo-accent*` reference with the new semantic tokens or hairline/sage/brass/ivory). |
| `src/components/ToolCallCard.tsx` | Replace the amber/blue/green icon system with the unified `§ TOOL_NAME` brass mono label + brass-dim left border. Keep the inline `style` approach (it was added in the fix cycle to defend against Tailwind cascade interference) but swap values to Onyx & Brass. |
| `src/components/ChatView.tsx` | Input bar gets italic-serif placeholder, brass-bordered focus, `⟶` send glyph. Streaming "Working..." pill becomes a brass-ghost italic-serif "Thinking…". Error block gains the brass-rule signature. Empty state speaks in italic serif. |

**Untouched**

- `src/components/AgentBar.tsx` — model switcher; redesigned in Phase 6 alongside the rest of side-surface polish.
- `src/stores/chatStore.ts` — data model and streaming logic are intact; we don't touch the engine.
- No backend changes.

---

## Tasks

### Task 1: `parseKeyPhrase` utility (TDD)

**Files:**
- Create: `src/lib/parseKeyPhrase.ts`
- Create: `src/lib/parseKeyPhrase.test.ts`

Pure function. Given assistant markdown content, return `{ keyPhrase, body }` where `keyPhrase` is the first complete sentence rendered as italic-serif display, and `body` is the rest rendered as markdown. If the response leads with a code block, fenced markdown, list, or has no recognizable lead sentence, `keyPhrase` is `null` and `body` is the entire input.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/parseKeyPhrase.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseKeyPhrase } from "./parseKeyPhrase";

describe("parseKeyPhrase", () => {
  it("splits a plain sentence + body", () => {
    const r = parseKeyPhrase("Because skipRefreshCheck is true. The flag was meant for tests only.");
    expect(r.keyPhrase).toBe("Because skipRefreshCheck is true.");
    expect(r.body).toBe("The flag was meant for tests only.");
  });

  it("works with ? and ! terminators", () => {
    expect(parseKeyPhrase("What if we ditched the cache? It seems redundant.").keyPhrase)
      .toBe("What if we ditched the cache?");
    expect(parseKeyPhrase("Done! All tests pass.").keyPhrase)
      .toBe("Done!");
  });

  it("preserves inline code in the key phrase", () => {
    const r = parseKeyPhrase("Because `skipRefreshCheck` is true. Body here.");
    expect(r.keyPhrase).toBe("Because `skipRefreshCheck` is true.");
    expect(r.body).toBe("Body here.");
  });

  it("returns null keyPhrase when content starts with a fenced code block", () => {
    const r = parseKeyPhrase("```ts\nconst x = 1;\n```\nThe code above…");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("```ts\nconst x = 1;\n```\nThe code above…");
  });

  it("returns null keyPhrase when content starts with a heading", () => {
    const r = parseKeyPhrase("# Plan\n\nFirst step is…");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("# Plan\n\nFirst step is…");
  });

  it("returns null keyPhrase when content starts with a list", () => {
    const r = parseKeyPhrase("- First item\n- Second item");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("- First item\n- Second item");
  });

  it("returns null when there is no body after the key phrase", () => {
    const r = parseKeyPhrase("All done.");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("All done.");
  });

  it("returns null when the lead sentence is too long (over 160 chars)", () => {
    const long = "This is a very long lead sentence that exceeds the threshold for what looks like a punchy display phrase and would render awkwardly large on the screen if treated as a heading, so we skip the parse.";
    const r = parseKeyPhrase(long + " Body content.");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe(long + " Body content.");
  });

  it("trims surrounding whitespace from both parts", () => {
    const r = parseKeyPhrase("  Hello there.    Second sentence.   ");
    expect(r.keyPhrase).toBe("Hello there.");
    expect(r.body).toBe("Second sentence.");
  });

  it("handles content with no terminator (returns null key phrase)", () => {
    const r = parseKeyPhrase("Just a fragment without punctuation");
    expect(r.keyPhrase).toBeNull();
    expect(r.body).toBe("Just a fragment without punctuation");
  });

  it("recognises punctuation followed by a streaming cursor block", () => {
    // The chat view appends "▊" to streaming content; the parser must not be
    // tripped up by it being attached to the body.
    const r = parseKeyPhrase("Found it. Looking at the file now▊");
    expect(r.keyPhrase).toBe("Found it.");
    expect(r.body).toBe("Looking at the file now▊");
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm test -- src/lib/parseKeyPhrase.test.ts
```

Expected: `Cannot find module './parseKeyPhrase'`.

- [ ] **Step 3: Implement `parseKeyPhrase`**

Create `src/lib/parseKeyPhrase.ts`:

```typescript
// Splits assistant content into a lead "key phrase" (rendered as Spectral
// italic display) and a body (rendered as markdown).
//
// Returns `keyPhrase: null` when the parse should be skipped — content
// starts with a code block, heading, list, has no sentence terminator,
// has no body after the lead, or the lead is too long.
//
// See docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md §4.3.

export interface KeyPhraseSplit {
  keyPhrase: string | null;
  body: string;
}

const MAX_KEY_PHRASE_LEN = 160;

// Matches the first complete sentence (greedy up to first ., !, or ?
// terminator). Captures the sentence and the remainder.
const SENTENCE_RE = /^([^.!?\n]+[.!?])\s*([\s\S]*)$/;

export function parseKeyPhrase(content: string): KeyPhraseSplit {
  const trimmed = content.trim();

  // Skip parse when content opens with structural markdown.
  if (
    trimmed.startsWith("```") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("- ") ||
    trimmed.startsWith("* ") ||
    /^\d+\.\s/.test(trimmed)
  ) {
    return { keyPhrase: null, body: trimmed };
  }

  const match = trimmed.match(SENTENCE_RE);
  if (!match) {
    return { keyPhrase: null, body: trimmed };
  }

  const lead = match[1].trim();
  const rest = match[2].trim();

  if (lead.length > MAX_KEY_PHRASE_LEN) {
    return { keyPhrase: null, body: trimmed };
  }

  if (rest.length === 0) {
    // Nothing after the lead — don't elevate a single sentence.
    return { keyPhrase: null, body: trimmed };
  }

  return { keyPhrase: lead, body: rest };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
npm test -- src/lib/parseKeyPhrase.test.ts
```

Expected: 11/11 pass.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parseKeyPhrase.ts src/lib/parseKeyPhrase.test.ts
git commit -m "feat: parseKeyPhrase utility for key-phrase / body split"
```

---

### Task 2: ChatMessage rewrite — editorial voice

**Files:**
- Modify (full rewrite): `src/components/ChatMessage.tsx`

Replace the chat-bubble component with the editorial format from the spec.

- [ ] **Step 1: Read the current file**

`src/components/ChatMessage.tsx` — review what's there (you've seen it from the plan-writing context — bubble UI, markdown components map referencing `bg-zinc-*` and `octo-accent`).

- [ ] **Step 2: Replace the entire file**

Overwrite `src/components/ChatMessage.tsx` with:

```tsx
import ReactMarkdown from "react-markdown";
import { clsx } from "clsx";
import type { Components } from "react-markdown";
import { parseKeyPhrase } from "../lib/parseKeyPhrase";

interface MessageProps {
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface Props {
  message: MessageProps;
}

// Maps Anthropic / OpenAI model IDs to short display names. Falls back to
// the raw ID when not in the table.
const MODEL_DISPLAY: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-7": "Opus 4.7",
  "claude-haiku-4-5": "Haiku 4.5",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o mini",
};

// Markdown renderers using Onyx & Brass design tokens. Body text only —
// the lead sentence (key phrase) is rendered separately above as italic serif.
const markdownComponents: Components = {
  code({ className, children, ...rest }) {
    const isInline = !className;
    if (isInline) {
      return (
        <code
          className="rounded-[3px] px-1.5 py-0.5 font-mono text-[12px] text-octo-brass"
          style={{ background: "var(--brass-ghost)" }}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className={clsx(
          "block overflow-x-auto rounded-md border border-octo-hairline bg-octo-onyx p-4 font-mono text-[12px] leading-relaxed text-octo-sage",
          className,
        )}
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <pre className="my-3 overflow-x-auto rounded-md">{children}</pre>;
  },
  p({ children }) {
    return <p className="mb-3 leading-[1.6] last:mb-0">{children}</p>;
  },
  ul({ children }) {
    return (
      <ul className="mb-3 ml-1 list-inside list-disc space-y-1.5 leading-[1.55] last:mb-0 marker:text-octo-mute">
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol className="mb-3 ml-1 list-inside list-decimal space-y-1.5 leading-[1.55] last:mb-0 marker:text-octo-brass">
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li className="leading-[1.55]">{children}</li>;
  },
  h1({ children }) {
    return (
      <h1 className="mb-3 mt-4 font-serif italic text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory first:mt-0">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mb-2 mt-4 font-serif italic text-[16px] text-octo-ivory first:mt-0">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mb-1.5 mt-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass first:mt-0">
        {children}
      </h3>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote
        className="my-3 py-1 pl-3 text-octo-sage"
        style={{ borderLeft: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }}
      >
        {children}
      </blockquote>
    );
  },
  hr() {
    return (
      <hr
        className="my-4 h-px border-0"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
    );
  },
  strong({ children }) {
    return <strong className="font-semibold text-octo-ivory">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic text-octo-ivory">{children}</em>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        className="text-octo-brass underline decoration-octo-brass/40 underline-offset-2 hover:decoration-octo-brass"
        target="_blank"
        rel="noopener"
      >
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded-md border border-octo-hairline">
        <table className="w-full text-[12px]">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border-b border-octo-hairline bg-octo-panel px-3 py-2 text-left font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border-b border-octo-hairline px-3 py-2 text-octo-sage">
        {children}
      </td>
    );
  },
};

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function modelDisplayName(model: string | null | undefined): string {
  if (!model) return "Assistant";
  return MODEL_DISPLAY[model] ?? model;
}

export function ChatMessage({ message }: Props) {
  const { role, content, model, inputTokens, outputTokens } = message;

  if (!content || !content.trim()) return null;

  if (role === "user") {
    return (
      <div data-role="user" className="flex flex-col gap-1.5">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
          — You
        </div>
        <div className="text-[14px] leading-[1.55] text-octo-ivory">
          {content}
        </div>
      </div>
    );
  }

  // Assistant: parse key phrase + body, render eyebrow + lead + markdown body.
  const { keyPhrase, body } = parseKeyPhrase(content);

  return (
    <div data-role="assistant" className="flex flex-col gap-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        — {modelDisplayName(model)}
      </div>

      {keyPhrase && (
        <ReactMarkdown
          components={{
            // Inline code inside the key phrase stays mono brass; other markdown
            // is unlikely in a single sentence but render gracefully.
            code({ children }) {
              return (
                <code className="font-mono not-italic text-octo-brass">
                  {children}
                </code>
              );
            },
            p({ children }) {
              return <p className="font-serif italic text-[20px] leading-[1.15] tracking-[-0.005em] text-octo-ivory">{children}</p>;
            },
          }}
        >
          {keyPhrase}
        </ReactMarkdown>
      )}

      {body && (
        <div className="text-[13px] leading-[1.6] text-octo-sage">
          <ReactMarkdown components={markdownComponents}>{body}</ReactMarkdown>
        </div>
      )}

      {(model || inputTokens != null || outputTokens != null) && (
        <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
          {[
            inputTokens != null ? `${formatTokenCount(inputTokens)} in` : null,
            outputTokens != null ? `${formatTokenCount(outputTokens)} out` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}
```

Key changes:
- User turn → "— You" mono brass eyebrow + ivory sans content. No bubble, no max-width.
- Assistant turn → "— Model Name" mono brass eyebrow + (optional) italic serif key phrase + markdown body in sage 13px. No bubble.
- Markdown components map → every color reference swapped to Onyx & Brass tokens. Lists, blockquotes, headings, links use brass/ivory/sage/mute.
- Inline `code` stays mono brass on brass-ghost background.
- Code blocks get a brass-dim border on onyx background.
- The streaming cursor character `▊` will end up in the body — that's correct.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all tests pass. (No existing test for `ChatMessage`; the new `parseKeyPhrase` tests cover the parsing logic.)

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatMessage.tsx
git commit -m "feat: editorial ChatMessage — eyebrow + key phrase + sage body"
```

---

### Task 3: ToolCallCard rewrite — `§` brass marginalia

**Files:**
- Modify (full rewrite): `src/components/ToolCallCard.tsx`

The current ToolCallCard uses inline styles (defensive measure from the previous debug cycle to avoid Tailwind cascade interference). KEEP the inline-style pattern, but swap every value to Onyx & Brass tokens, and replace the per-tool icon-and-color system with the unified `§ TOOL_NAME` brass mono label.

- [ ] **Step 1: Read the current file**

`src/components/ToolCallCard.tsx` — note the structure (header row with expand chevron, icon box, label, summary; optional Reveal-in-Finder and Open buttons; expanded result with Copy button).

- [ ] **Step 2: Replace the entire file**

Overwrite `src/components/ToolCallCard.tsx` with:

```tsx
import { useState, type CSSProperties } from "react";
import { ipc } from "../lib/ipc";
import type { ToolExecution } from "../stores/chatStore";

interface Props {
  tool: ToolExecution;
  workspacePath?: string;
}

// Tool name → uppercase mono label. Falls back to the raw tool name.
const TOOL_LABELS: Record<string, string> = {
  run_command: "RUN",
  read_file: "READ",
  write_file: "WRITE",
  list_files: "LIST",
};

// Onyx & Brass design tokens (CSS variables resolved at runtime).
// Defined inline because this component is rendered inside react-markdown
// siblings — the previous fix cycle (commit d9c1517) proved Tailwind cascade
// can leak in this context. Inline styles are deliberate and load-bearing.
const BRASS = "#d4a574";
const BRASS_DIM = "rgba(212, 165, 116, 0.4)";
const BRASS_GHOST = "rgba(212, 165, 116, 0.08)";
const IVORY = "#f4ecdb";
const SAGE = "#95897a";
const MUTE = "#6d6354";
const ONYX = "#0c0a08";
const HAIRLINE = "#2a2419";

const cardStyle: CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: "100%",
  margin: "8px 0",
  borderRadius: 6,
  borderLeft: `1px solid ${BRASS_DIM}`,
  background: BRASS_GHOST,
  fontSize: 12,
  fontFamily: "-apple-system, 'Helvetica Neue', sans-serif",
  color: SAGE,
  lineHeight: "1.4",
  boxSizing: "border-box" as const,
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  padding: "8px 12px",
  gap: 10,
  cursor: "pointer",
  background: "transparent",
  border: "none",
  color: "inherit",
  fontSize: "inherit",
  fontFamily: "inherit",
  lineHeight: "inherit",
  textAlign: "left" as const,
  boxSizing: "border-box" as const,
};

export function ToolCallCard({ tool, workspacePath }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName.toUpperCase();
  const summary = buildSummary(tool);
  const filePath = getFilePath(tool);
  const isWebFile = filePath ? /\.(html?|htm)$/i.test(filePath) : false;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
          style={headerStyle}
        >
          <span
            style={{
              fontSize: 13,
              color: BRASS,
              fontFamily: "'Spectral', serif",
              fontStyle: "italic",
              flexShrink: 0,
              transform: expanded ? "rotate(0deg)" : "none",
              transition: "transform 150ms",
            }}
            aria-hidden
          >
            §
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: BRASS,
              flexShrink: 0,
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontSize: 11,
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              color: SAGE,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: 1,
              marginLeft: 4,
            }}
          >
            {summary}
          </span>
          <span
            style={{
              fontSize: 10,
              color: MUTE,
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 150ms",
              flexShrink: 0,
            }}
            aria-hidden
          >
            ▸
          </span>
        </div>

        {/* Reveal in Finder for write_file */}
        {filePath && tool.toolName === "write_file" && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (workspacePath) ipc.revealInFinder(`${workspacePath}/${filePath}`);
            }}
            onKeyDown={() => {}}
            title="Reveal in Finder"
            style={{
              fontSize: 12,
              color: MUTE,
              background: "transparent",
              border: "none",
              padding: "4px 8px",
              cursor: "pointer",
              marginRight: 4,
              flexShrink: 0,
              fontFamily: "system-ui, sans-serif",
              lineHeight: 1,
            }}
          >
            ⊙
          </div>
        )}

        {/* Open in system for HTML files */}
        {filePath && tool.toolName === "write_file" && isWebFile && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (workspacePath) ipc.openFileInSystem(`${workspacePath}/${filePath}`);
            }}
            onKeyDown={() => {}}
            style={{
              fontFamily: "'Spectral', serif",
              fontStyle: "italic",
              fontSize: 11,
              color: BRASS,
              background: BRASS_GHOST,
              border: `1px solid ${BRASS_DIM}`,
              borderRadius: 4,
              padding: "3px 10px",
              cursor: "pointer",
              marginRight: 10,
              flexShrink: 0,
            }}
          >
            Open
          </div>
        )}
      </div>

      {/* Expanded result */}
      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${HAIRLINE}`,
            padding: "8px 12px 12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => {
                navigator.clipboard.writeText(tool.result);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              onKeyDown={() => {}}
              style={{
                fontSize: 9,
                fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: copied ? "#8fc9a8" : MUTE,
                cursor: "pointer",
                padding: "2px 6px",
              }}
            >
              {copied ? "✓ COPIED" : "COPY"}
            </span>
          </div>
          <pre
            style={{
              maxHeight: 256,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              borderRadius: 4,
              background: ONYX,
              padding: "10px 12px",
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              fontSize: 11,
              lineHeight: 1.55,
              color: IVORY,
              margin: 0,
              boxSizing: "border-box" as const,
              border: `1px solid ${HAIRLINE}`,
            }}
          >
            {tool.result}
          </pre>
        </div>
      )}
    </div>
  );
}

function buildSummary(tool: ToolExecution): string {
  switch (tool.toolName) {
    case "run_command": {
      const cmd = String(tool.toolInput?.command ?? "");
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "write_file":
    case "read_file":
      return String(tool.toolInput?.path ?? "");
    case "list_files":
      return String(tool.toolInput?.path ?? ".");
    default:
      return tool.toolName;
  }
}

function getFilePath(tool: ToolExecution): string | null {
  if (tool.toolName === "write_file" || tool.toolName === "read_file") {
    return String(tool.toolInput?.path ?? "") || null;
  }
  return null;
}
```

Key changes:
- Card has a **brass-dim left border + brass-ghost fill** (no full border, no rounded chat-bubble feel).
- Header row layout: `§` brass italic-serif glyph (the signature), brass mono `RUN/READ/WRITE/LIST` label (uppercase, 0.2em tracking), then the file path / command summary in mono sage. Chevron moved to the right edge in mute.
- Per-tool color/icon table removed. Every tool reads as `§ TOOL_NAME summary`.
- "Open" button for HTML files now uses italic serif on brass-ghost (matches the editorial CTA pattern from the spec, no more purple).
- Expanded result's "Copy" affordance uppercased + mono brass; "✓ COPIED" success uses the verdigris hex literal `#8fc9a8`.
- Expanded result pre block: ivory text on onyx with a hairline border — feels integrated with the chat, not a popped-out box.
- Brass and other colors remain inline hex literals because the component is intentionally not Tailwind-coupled (defends against markdown-sibling cascade — that decision from the previous fix cycle still holds).

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ToolCallCard.tsx
git commit -m "feat: ToolCallCard with § brass marginalia label"
```

---

### Task 4: ChatView polish — input, streaming, error, empty state

**Files:**
- Modify: `src/components/ChatView.tsx`

Polish the surfaces around the message list: the empty state, the working/streaming indicator, the error block, and especially the input bar (italic-serif placeholder, brass focus border, `⟶` send glyph).

- [ ] **Step 1: Read the current `ChatView.tsx`**

Note the existing structure: `<AgentBar>` at top, scrolling message list with empty/streaming/error states, then the input bar at the bottom with a model indicator and a circular send button.

- [ ] **Step 2: Replace the entire file**

Overwrite `src/components/ChatView.tsx` with:

```tsx
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { AlertTriangle, Settings } from "lucide-react";
import { clsx } from "clsx";
import { useChatStore, type ToolExecution, type ConversationItem } from "../stores/chatStore";
import { AgentBar } from "./AgentBar";
import { ChatMessage } from "./ChatMessage";
import { ToolCallCard } from "./ToolCallCard";

interface Props {
  workspaceId: string;
  workspacePath: string;
  onOpenSettings?: () => void;
}

export function ChatView({ workspaceId, workspacePath, onOpenSettings }: Props) {
  const { messages, streaming, streamBuffer, model, error, loadHistory, send, setModel, clearError } =
    useChatStore();

  // Compute the timeline (messages + tool cards interleaved).
  const timeline = useMemo<ConversationItem[]>(() => {
    const items: ConversationItem[] = [];
    for (const msg of messages) {
      const role = String(msg.role);
      if (role === "tool") {
        try {
          const tool: ToolExecution = JSON.parse(msg.content);
          items.push({ kind: "tool", tool, id: msg.id });
        } catch {
          items.push({ kind: "message", message: msg });
        }
      } else {
        items.push({ kind: "message", message: msg });
      }
    }
    return items;
  }, [messages]);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadHistory(workspaceId);
  }, [workspaceId, loadHistory]);

  useEffect(() => {
    if (streaming) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [streaming, streamBuffer]);

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    const lineHeight = 20;
    const maxHeight = lineHeight * 6 + 24;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    send(workspaceId, workspacePath, trimmed);
  }, [input, streaming, send, workspaceId, workspacePath]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const canSend = !streaming && input.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentBar activeModel={model} onSelectModel={setModel} />

      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-6"
      >
        {messages.length === 0 && !streaming ? (
          <EmptyState />
        ) : (
          <>
            {timeline.map((item) =>
              item.kind === "tool" ? (
                <ToolCallCard
                  key={`tool-${item.id}`}
                  tool={item.tool}
                  workspacePath={workspacePath}
                />
              ) : (
                <ChatMessage key={item.message.id} message={item.message} />
              ),
            )}

            {/* Streaming partial — append cursor character to the buffer */}
            {streaming && streamBuffer && (
              <ChatMessage
                message={{
                  role: "assistant",
                  content: streamBuffer + "▊",
                  model,
                  inputTokens: null,
                  outputTokens: null,
                }}
              />
            )}

            {/* Thinking indicator when streaming with no buffer yet (e.g. mid tool call) */}
            {streaming && !streamBuffer && <ThinkingIndicator />}

            {error && (
              <ErrorBlock
                error={error}
                onConfigureApiKey={onOpenSettings ? () => { clearError(); onOpenSettings(); } : null}
              />
            )}
          </>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-octo-hairline bg-octo-panel px-6 py-4">
        <div
          className={clsx(
            "rounded-xl border bg-octo-onyx transition-colors",
            streaming
              ? "border-octo-hairline opacity-60"
              : "border-octo-hairline focus-within:border-octo-brass",
          )}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            placeholder="Ask Octopus anything…"
            rows={1}
            className="w-full resize-none bg-transparent px-4 py-3 text-[14px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute"
            style={{ maxHeight: "calc(6 * 1.25rem + 1.5rem)" }}
          />

          <div className="flex items-center justify-between px-3 pb-2.5">
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
              ⌘ K to focus
            </div>

            <button
              onClick={handleSend}
              disabled={!canSend}
              title="Send (Enter)"
              aria-label="Send message"
              className="flex h-7 items-center gap-1.5 rounded-md px-3 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                color: canSend ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
                background: canSend ? "var(--brass-ghost)" : "transparent",
                border: canSend ? "1px solid var(--brass-dim)" : "1px solid var(--color-octo-hairline)",
              }}
            >
              <span style={{ fontSize: 12, lineHeight: 1 }} aria-hidden>
                ⟶
              </span>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Talk
      </div>
      <div className="font-serif italic text-[24px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Begin a conversation.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        Ask anything — Octopus will read files, run commands, and write changes inside this workspace's worktree.
      </p>
      <div
        aria-hidden
        className="mt-2 h-px w-7"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 self-start">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
        style={{ background: "var(--color-octo-brass)" }}
      />
      <span className="font-serif italic text-[13px] text-octo-sage">Thinking…</span>
    </div>
  );
}

function ErrorBlock({
  error,
  onConfigureApiKey,
}: {
  error: string;
  onConfigureApiKey: (() => void) | null;
}) {
  return (
    <div
      className="mx-auto max-w-lg rounded-md p-4"
      style={{
        borderLeft: "1px solid var(--color-octo-rouge)",
        background: "rgba(209, 139, 139, 0.08)",
      }}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-octo-rouge" />
        <div className="min-w-0 flex-1">
          <div className="font-serif italic text-[14px] text-octo-rouge">
            Something went wrong.
          </div>
          <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{error}</div>
          {error.includes("API key") && onConfigureApiKey && (
            <button
              onClick={onConfigureApiKey}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:text-octo-brass"
            >
              <Settings size={11} />
              Configure API key
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

Key changes:
- **Empty state**: "Talk" mono brass eyebrow, "Begin a conversation." italic serif, sage descriptive copy, brass rule decoration (matches the spec's brass-rule signature).
- **Thinking indicator**: pulse brass dot + italic-serif "Thinking…" instead of a grey "Working..." pill.
- **Error block**: rouge left border + rouge italic-serif "Something went wrong." headline + sage body. The "Configure API key" CTA is a mono uppercase button.
- **Input bar**: italic-serif placeholder ("Ask Octopus anything…"), brass focus border, "⌘ K to focus" mono hint on the left, **`⟶ Send`** brass button (replaces the round-arrow purple circle) — this carries the spec's `⟶` signature.
- Constants for the agent name/color in the old file are removed (now lives in ChatMessage's `MODEL_DISPLAY` map).

- [ ] **Step 3: Typecheck and tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: clean + all tests pass.

- [ ] **Step 4: Boot dev server**

```bash
npm run dev 2>&1 | head -10
```

Watch for any errors. Kill it after you see "VITE ready". (No `timeout` on macOS — `Ctrl+C` after a few seconds.)

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatView.tsx
git commit -m "feat: ChatView polish — input ⟶, italic-serif empty/thinking/error"
```

---

### Task 5: Debug cleanup

**Files:** any file with leftover debug artifacts.

The recent ChatView/ToolCallCard fix cycle (commits like `d079d1d` "debug: red tool divs", `c6a2960` "debug: visible timeline counter", `7cdb73c` "debug: add console.log") may have left orphan `console.log`, debug counters, or commented-out experiments. Hunt them down.

- [ ] **Step 1: Scan for likely debug artifacts**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
grep -rn "console\.log\|console\.error\|console\.warn\|console\.debug" src/components/ChatView.tsx src/components/ChatMessage.tsx src/components/ToolCallCard.tsx src/stores/chatStore.ts 2>&1
grep -rn "DEBUG\|TODO\|FIXME\|XXX\|HACK" src/components/ChatView.tsx src/components/ChatMessage.tsx src/components/ToolCallCard.tsx src/stores/chatStore.ts 2>&1
```

Expected: ChatView and ChatMessage are clean (you just rewrote them). ToolCallCard intentionally has the "Inline styles are deliberate and load-bearing" comment — preserve that. `chatStore.ts` MAY have residual debug from the fix cycle.

- [ ] **Step 2: If you find any console.log / DEBUG markers in `chatStore.ts`, remove them**

For each match in `src/stores/chatStore.ts` that looks like debug output (e.g., `console.log("timeline:", ...)`, `console.log("DEBUG:", ...)`), delete the line. Keep `console.error` for genuine error paths.

If no matches, that's fine — skip to Step 3.

- [ ] **Step 3: Confirm tests still pass**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 4: Commit (only if you removed something)**

```bash
git add src/stores/chatStore.ts
git commit -m "chore: remove debug artifacts from chat surface"
```

If nothing changed, skip the commit.

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Branch state**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git log --oneline -10
```

Expected: 4–5 Phase 4 commits on top of the Mini-Phase 3 merge.

- [ ] **Step 2: Full test sweep**

```bash
npm run typecheck && npm test
cd src-tauri && cargo test
```

Expected: all green.

- [ ] **Step 3: Boot the dev server**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run dev 2>&1 | head -20
```

Vite should be ready within ~2s with no errors. Kill after the ready message.

- [ ] **Step 4: Visual verification (user)**

User will boot `npm run tauri:dev` and verify:

- Send a message → user turn shows "— You" eyebrow + ivory sans text (no bubble).
- Model reply leads with italic-serif "key phrase" + sage markdown body. Inline code in brass.
- Tool execution → card with `§ READ` (or RUN/WRITE/LIST) brass mono label + brass-dim left border. No more amber/blue/green per-tool colors.
- Empty workspace → "Talk · Begin a conversation." with brass rule.
- During streaming with no buffer (tool mid-call) → italic-serif "Thinking…" with brass pulse.
- Error state → rouge left border, italic-serif "Something went wrong.", sage detail.
- Input bar placeholder → italic serif "Ask Octopus anything…". Send button → brass `⟶ Send`.

- [ ] **Step 5: Report any blockers**

Surface what's broken (if anything). Small fixes commit as `fix: <surface> in Phase 4 chat soul`.

---

## Self-review notes

**Spec coverage:**
- §4.3 hero canvas: eyebrow + key phrase + body + tool card → Tasks 2, 3 ✓
- §5.2 key-phrase fade-in animation → NOT implemented this phase (motion lives in Phase 7); the parse + render is in place, animation joins later. Acceptable per the spec's phase split.
- §6 signature moments: `§` tool labels ✓, `⟶` prompt glyph in input ✓, italic-serif phrases (placeholders, CTAs, headlines) ✓, brass rule in empty state ✓, brass ampersand is Welcome-screen territory (Phase 5).

**Architecture/Type consistency:**
- `parseKeyPhrase` returns `{ keyPhrase: string \| null; body: string }` consistently.
- `ChatMessage` accepts the existing `MessageProps` shape — no signature change.
- `ToolCallCard` keeps its existing prop shape (`{ tool, workspacePath }`).
- `ChatView` extracts helper components (`EmptyState`, `ThinkingIndicator`, `ErrorBlock`) inline to keep the main render readable.

**Risks:**
- `parseKeyPhrase` runs on every assistant message render. Cheap (regex on a short string), but during heavy streaming it executes hundreds of times per second. The regex is simple and short-circuits early; no memoization added. If profiling shows a hot path, wrap with `useMemo` inside `ChatMessage`.
- The `▊` cursor character ends up in the body during streaming. Tested via `parseKeyPhrase.test.ts` case "recognises punctuation followed by a streaming cursor block".
- `AgentBar` still uses old design tokens — model switcher will look slightly out of step with the new chat. Acceptable for Phase 4; AgentBar is in Phase 6 scope.
- Code blocks inside body markdown use `bg-octo-onyx` (the same as app background). On a workspace canvas this might make the code block invisible against the page bg. The `border-octo-hairline` provides the visual boundary. If it reads poorly in practice, swap to a slightly different surface — but a hairline-bordered onyx block reads correctly in similar editorial tools.

**Phase 4 ships when:**
- All 5 implementation commits land on the branch.
- `npm run typecheck && npm test && cargo test` pass.
- Visual smoke (Task 6 Step 4) confirms editorial voice across user/assistant/tool/streaming/error/empty/input surfaces.
