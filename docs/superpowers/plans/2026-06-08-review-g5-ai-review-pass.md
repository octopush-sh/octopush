# G5 · AI Review Pass (slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Add a manually-triggered AI Review Pass to Review mode — a one-shot model analysis of the worktree diff that returns structured findings (severity · category · title · file:line) in a Companion section, each linking into the diff — built on a thin reusable `ai_complete` primitive over Octopush's existing Rust LLM path.

**Architecture:** New `ai_complete` Tauri command reuses `chat_engine::resolve_provider` + `LlmProvider::complete` (no JS SDK, no new HTTP client logic). Frontend: `lib/aiReview.ts` (prompt + tolerant JSON parse), `stores/aiReviewStore.ts` (per-workspace state, persisted model), and `review/AiReviewPanel.tsx` + `AiFindingCard.tsx` wired into the Companion's review branch. Reuses G3's diff (`navigateToFile`) and `ModelPicker`.

**Tech Stack:** Rust (Tauri command), React 19 + TS, Zustand (+persist), Tailwind tokens, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-08-review-g5-ai-review-pass-design.md`. **Branch:** `feat/review-g5-ai` (already checked out, off `main`). Run `npm run typecheck` + `npx vitest run` after each frontend task; keep green.

---

## Task 1: Backend `ai_complete` primitive + IPC

**Files:** Modify `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`.

Verified facts: `chat_engine::resolve_provider(model) -> AppResult<(Box<dyn LlmProvider>, String, Option<String>)>` is `pub(crate)` (`chat_engine.rs:263`). `LlmRequest { model:String, max_tokens:u32, system:String, messages:Vec<LlmMessage>, tools:Vec<LlmTool> }`; `LlmMessage { role: LlmRole, content: LlmContent }`; `LlmRole::User`; `LlmContent::Text(String)` (`providers/mod.rs`). `token_engine::compute_cost(model,&,in,out,cache_read,cache_creation)->f64` is a free fn (`token_engine.rs:123`). `LlmContent` does NOT derive `PartialEq` (match it, don't `assert_eq`). Tauri auto-maps camelCase JS args → snake_case Rust params; return structs serialize as-is, so add `#[serde(rename_all="camelCase")]`.

- [ ] **Step 1: Write the failing Rust test.** Append to the bottom of `src-tauri/src/commands.rs`:
```rust
#[cfg(test)]
mod ai_complete_tests {
    use crate::providers::{LlmContent, LlmRole};

    #[test]
    fn build_ai_request_makes_one_user_text_message_no_tools() {
        let req = super::build_ai_request("claude-sonnet-4-6", "SYS".into(), "PROMPT".into(), 8192);
        assert_eq!(req.model, "claude-sonnet-4-6");
        assert_eq!(req.max_tokens, 8192);
        assert_eq!(req.system, "SYS");
        assert_eq!(req.tools.len(), 0);
        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].role, LlmRole::User);
        match &req.messages[0].content {
            LlmContent::Text(t) => assert_eq!(t, "PROMPT"),
            _ => panic!("expected Text content"),
        }
    }
}
```

- [ ] **Step 2: Run it — fails** (`cd src-tauri && cargo test build_ai_request`): `build_ai_request` not found.

- [ ] **Step 3: Implement the helper + command** in `src-tauri/src/commands.rs`. Add near the other commands (and the `use` at the top of the file if not present):
```rust
use crate::providers::{LlmRequest, LlmMessage, LlmRole, LlmContent};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompleteResult {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// Pure request builder — one user/text message, no tools. Unit-testable.
pub fn build_ai_request(model: &str, system: String, prompt: String, max_tokens: u32) -> LlmRequest {
    LlmRequest {
        model: model.to_string(),
        max_tokens,
        system,
        messages: vec![LlmMessage { role: LlmRole::User, content: LlmContent::Text(prompt) }],
        tools: vec![],
    }
}

/// Generic one-shot model call. The shared G5 AI primitive (reused by later
/// AI features). Returns text + token counts + computed cost. Does NOT record
/// to the token DB in slice 1 (cost is returned for the panel to display).
#[tauri::command]
pub async fn ai_complete(
    model: String,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
) -> AppResult<AiCompleteResult> {
    let (provider, api_base, api_key) = crate::chat_engine::resolve_provider(&model)?;
    let req = build_ai_request(&model, system, prompt, max_tokens.unwrap_or(8192));
    let client = reqwest::Client::new();
    let resp = provider.complete(&api_base, api_key.as_deref(), &req, &client).await?;
    let cost = crate::token_engine::compute_cost(&model, resp.input_tokens, resp.output_tokens, 0, 0);
    Ok(AiCompleteResult {
        text: resp.text,
        input_tokens: resp.input_tokens,
        output_tokens: resp.output_tokens,
        cost_usd: cost,
    })
}
```
(If `AppResult`/`AppError` aren't already imported in commands.rs, they are — this file already returns `AppResult`. Confirm `reqwest` is a dep — it is, used by providers.)

- [ ] **Step 4: Register** `commands::ai_complete,` in the `tauri::generate_handler![ ... ]` list in `src-tauri/src/lib.rs` (add a line next to the other `commands::*` entries).

- [ ] **Step 5: Run `cargo test build_ai_request` — pass.** Then `cargo build` (or `cargo check`) to confirm the command compiles + registers.

- [ ] **Step 6: Frontend IPC.** In `src/lib/ipc.ts`, add to the exported `ipc` object (near the other invoke methods):
```ts
aiComplete: (model: string, system: string, prompt: string, maxTokens?: number) =>
  invoke<{ text: string; inputTokens: number; outputTokens: number; costUsd: number }>(
    "ai_complete",
    { model, system, prompt, maxTokens },
  ),
```

- [ ] **Step 7: Verify + commit.**
```bash
cd src-tauri && cargo test build_ai_request && cd ..
npm run typecheck
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/lib/ipc.ts
git commit -m "feat(g5): ai_complete primitive — thin wrapper over LlmProvider + ipc"
```

---

## Task 2: `lib/aiReview.ts` — types, prompt, tolerant parse

**Files:** Create `src/lib/aiReview.ts`, `src/lib/aiReview.test.ts`.

- [ ] **Step 1: Write the failing test** `src/lib/aiReview.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseAiReview, buildReviewPrompt } from "./aiReview";

const valid = JSON.stringify({
  summary: "Adds a word-diff",
  findings: [
    { severity: "high", category: "security", title: "Unescaped path", detail: "x", file: "a.rs", line: 12 },
    { severity: "low", category: "style", title: "Naming", detail: "", file: null, line: null },
  ],
});

describe("parseAiReview", () => {
  it("parses a clean JSON object", () => {
    const r = parseAiReview(valid);
    expect(r.summary).toBe("Adds a word-diff");
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatchObject({ severity: "high", category: "security", file: "a.rs", line: 12 });
    expect(r.findings[1].file).toBeNull();
  });
  it("strips ```json fences", () => {
    expect(parseAiReview("```json\n" + valid + "\n```").findings).toHaveLength(2);
  });
  it("ignores prose around the object", () => {
    expect(parseAiReview("Sure! Here:\n" + valid + "\nDone.").summary).toBe("Adds a word-diff");
  });
  it("drops invalid findings (bad severity/category/missing title)", () => {
    const bad = JSON.stringify({ summary: "s", findings: [
      { severity: "huge", category: "security", title: "x" },
      { severity: "high", category: "nope", title: "x" },
      { severity: "high", category: "bug" },
      { severity: "high", category: "bug", title: "kept", detail: "d" },
    ]});
    const r = parseAiReview(bad);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toBe("kept");
  });
  it("accepts an empty findings array", () => {
    expect(parseAiReview(JSON.stringify({ summary: "clean", findings: [] })).findings).toEqual([]);
  });
  it("throws when there is no JSON object", () => {
    expect(() => parseAiReview("no json here")).toThrow();
  });
});

describe("buildReviewPrompt", () => {
  it("embeds the diff", () => {
    expect(buildReviewPrompt("DIFF")).toContain("DIFF");
  });
});
```

- [ ] **Step 2: Run it — fails** (module not found).

- [ ] **Step 3: Implement `src/lib/aiReview.ts`:**
```ts
export type Severity = "high" | "medium" | "low";
export type Category = "bug" | "missing-test" | "security" | "style" | "perf" | "other";

export interface AiFinding {
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  file: string | null;
  line: number | null;
}
export interface AiReviewResult {
  summary: string;
  findings: AiFinding[];
}

export const AI_REVIEW_SYSTEM = `You are a meticulous senior code reviewer. You are given a unified git diff of a change a developer is about to commit. Review ONLY what the diff shows. Surface concrete, actionable issues: bugs, missing tests, security problems, performance regressions, and notable style problems. Do not praise; do not restate the diff.

Respond with ONLY a JSON object, no prose outside it, matching exactly:
{"summary":"<=160 chars: what the change does + the single biggest risk","findings":[{"severity":"high|medium|low","category":"bug|missing-test|security|style|perf|other","title":"<=80 chars","detail":"1-2 sentences","file":"path exactly as in the diff, or null","line":<new-file line number from the @@ header, or null>}]}
Use file/line when a finding maps to a specific changed line; use null for changeset-level findings. Order findings by severity (high first). If the change is clean, return an empty findings array with a summary saying so.`;

export function buildReviewPrompt(gitDiff: string): string {
  return `Here is the unified diff to review:\n\n${gitDiff}`;
}

const SEVERITIES = new Set<string>(["high", "medium", "low"]);
const CATEGORIES = new Set<string>(["bug", "missing-test", "security", "style", "perf", "other"]);

/** Tolerant: strips ```json fences + surrounding prose, parses the outermost
 *  object, validates shape, drops invalid findings. Throws if no parseable
 *  object is present. */
export function parseAiReview(text: string): AiReviewResult {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("AI review returned no JSON object");
  }
  const obj = JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: AiFinding[] = rawFindings
    .filter(
      (f): f is Record<string, unknown> =>
        !!f &&
        typeof f === "object" &&
        SEVERITIES.has((f as any).severity) &&
        CATEGORIES.has((f as any).category) &&
        typeof (f as any).title === "string" &&
        ((f as any).title as string).length > 0,
    )
    .map((f) => ({
      severity: f.severity as Severity,
      category: f.category as Category,
      title: f.title as string,
      detail: typeof f.detail === "string" ? (f.detail as string) : "",
      file: typeof f.file === "string" && f.file ? (f.file as string) : null,
      line: typeof f.line === "number" ? (f.line as number) : null,
    }));
  return { summary, findings };
}
```

- [ ] **Step 4: Run the test + full suite — green.** `npx vitest run src/lib/aiReview.test.ts` then `npx vitest run`. `npm run typecheck`.

- [ ] **Step 5: Commit.**
```bash
git add src/lib/aiReview.ts src/lib/aiReview.test.ts
git commit -m "feat(g5): aiReview lib — system prompt + tolerant findings parser"
```

---

## Task 3: `stores/aiReviewStore.ts`

**Files:** Create `src/stores/aiReviewStore.ts`, `src/stores/aiReviewStore.test.ts`.

- [ ] **Step 1: Write the failing test** `src/stores/aiReviewStore.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: { aiComplete: vi.fn() },
}));
import { ipc } from "../lib/ipc";
import { useAiReview, diffHash } from "./aiReviewStore";

const okJson = JSON.stringify({ summary: "s", findings: [{ severity: "high", category: "bug", title: "t", detail: "d", file: "a.ts", line: 3 }] });

beforeEach(() => {
  localStorage.clear();
  useAiReview.setState({ models: {}, reviews: {} });
  (ipc.aiComplete as any).mockReset();
});

describe("aiReviewStore", () => {
  it("defaults the model to claude-sonnet-4-6 per workspace", () => {
    expect(useAiReview.getState().modelFor("w1")).toBe("claude-sonnet-4-6");
  });
  it("setModel persists per workspace", () => {
    useAiReview.getState().setModel("w1", "claude-opus-4-6");
    expect(useAiReview.getState().modelFor("w1")).toBe("claude-opus-4-6");
    expect(localStorage.getItem("octo-ai-review")).toContain("claude-opus-4-6");
  });
  it("run goes running → done and stamps the diff hash", async () => {
    (ipc.aiComplete as any).mockResolvedValue({ text: okJson, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    const p = useAiReview.getState().run("w1", "DIFF");
    expect(useAiReview.getState().reviewFor("w1").status).toBe("running");
    await p;
    const r = useAiReview.getState().reviewFor("w1");
    expect(r.status).toBe("done");
    expect(r.result?.findings).toHaveLength(1);
    expect(r.diffHash).toBe(diffHash("DIFF"));
  });
  it("run sets error on ipc failure", async () => {
    (ipc.aiComplete as any).mockRejectedValue(new Error("no key"));
    await useAiReview.getState().run("w1", "DIFF");
    const r = useAiReview.getState().reviewFor("w1");
    expect(r.status).toBe("error");
    expect(r.error).toContain("no key");
  });
  it("diffHash changes with the diff (freshness)", () => {
    expect(diffHash("a")).not.toBe(diffHash("b"));
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement `src/stores/aiReviewStore.ts`:**
```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ipc } from "../lib/ipc";
import { AI_REVIEW_SYSTEM, buildReviewPrompt, parseAiReview, type AiReviewResult } from "../lib/aiReview";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export type ReviewStatus = "idle" | "running" | "done" | "error";
export interface WsReview {
  status: ReviewStatus;
  result: AiReviewResult | null;
  diffHash: string | null;
  error: string | null;
  rawText: string | null;
}
const EMPTY: WsReview = { status: "idle", result: null, diffHash: null, error: null, rawText: null };

/** Stable FNV-1a hash of the diff string — used to detect "diff changed". */
export function diffHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface State {
  models: Record<string, string>;     // persisted (per workspace)
  reviews: Record<string, WsReview>;  // ephemeral
  modelFor: (ws: string) => string;
  reviewFor: (ws: string) => WsReview;
  setModel: (ws: string, model: string) => void;
  clearError: (ws: string) => void;
  run: (ws: string, gitDiff: string) => Promise<void>;
}

export const useAiReview = create<State>()(
  persist(
    (set, get) => ({
      models: {},
      reviews: {},
      modelFor: (ws) => get().models[ws] ?? DEFAULT_MODEL,
      reviewFor: (ws) => get().reviews[ws] ?? EMPTY,
      setModel: (ws, model) => set((s) => ({ models: { ...s.models, [ws]: model } })),
      clearError: (ws) =>
        set((s) => ({ reviews: { ...s.reviews, [ws]: { ...(s.reviews[ws] ?? EMPTY), error: null } } })),
      run: async (ws, gitDiff) => {
        const model = get().modelFor(ws);
        set((s) => ({ reviews: { ...s.reviews, [ws]: { ...EMPTY, status: "running" } } }));
        try {
          const res = await ipc.aiComplete(model, AI_REVIEW_SYSTEM, buildReviewPrompt(gitDiff));
          const result = parseAiReview(res.text);
          set((s) => ({
            reviews: { ...s.reviews, [ws]: { status: "done", result, diffHash: diffHash(gitDiff), error: null, rawText: res.text } },
          }));
        } catch (e) {
          set((s) => ({
            reviews: { ...s.reviews, [ws]: { status: "error", result: null, diffHash: null, error: String(e), rawText: null } },
          }));
        }
      },
    }),
    { name: "octo-ai-review", partialize: (s) => ({ models: s.models }) },
  ),
);
```

- [ ] **Step 4: Run the test + full suite + typecheck — green.**
- [ ] **Step 5: Commit.**
```bash
git add src/stores/aiReviewStore.ts src/stores/aiReviewStore.test.ts
git commit -m "feat(g5): aiReviewStore — per-ws state, persisted model, diff-hash freshness"
```

---

## Task 4: `components/review/AiFindingCard.tsx`

**Files:** Create `src/components/review/AiFindingCard.tsx`, `src/components/review/AiFindingCard.test.tsx`.

Tokens: `--brass-dim` (high-severity dot/rule), `--brass-rule-dim` (low rule — added in G3), `text-octo-sage`/`text-octo-mute` (medium/low dots via Tailwind classes). NO inline hex/rgba.

- [ ] **Step 1: Write the failing test:**
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AiFindingCard } from "./AiFindingCard";
import type { AiFinding } from "../../lib/aiReview";

const f: AiFinding = { severity: "high", category: "security", title: "Unescaped path", detail: "x", file: "a.rs", line: 12 };
const noFile: AiFinding = { severity: "low", category: "style", title: "Naming", detail: "", file: null, line: null };

describe("AiFindingCard", () => {
  it("renders category + title + jump link", () => {
    const onJump = vi.fn();
    const { getByText, getByRole } = render(<AiFindingCard finding={f} onJump={onJump} />);
    expect(getByText("Unescaped path")).toBeTruthy();
    expect(getByText(/security/i)).toBeTruthy();
    fireEvent.click(getByRole("button"));
    expect(onJump).toHaveBeenCalledWith("a.rs", 12);
  });
  it("is not clickable when there is no file", () => {
    const { queryByRole } = render(<AiFindingCard finding={noFile} onJump={() => {}} />);
    expect(queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement:**
```tsx
import type { AiFinding } from "../../lib/aiReview";

const DOT: Record<AiFinding["severity"], string> = {
  high: "var(--brass-dim)",
  medium: "var(--color-octo-sage)",
  low: "var(--color-octo-mute)",
};

export function AiFindingCard({
  finding,
  onJump,
}: {
  finding: AiFinding;
  onJump: (file: string, line: number | null) => void;
}) {
  return (
    <div
      className="octo-rise-in border-l-2 px-2 py-1.5"
      style={{ borderLeftColor: finding.severity === "high" ? "var(--brass-dim)" : "var(--brass-rule-dim)" }}
      data-severity={finding.severity}
    >
      <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
        <span aria-hidden className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: DOT[finding.severity] }} />
        <span>{finding.category} · {finding.severity}</span>
      </div>
      <div className="mt-0.5 text-[12px] text-octo-ivory">{finding.title}</div>
      {finding.detail && <div className="text-[11px] leading-[1.5] text-octo-sage">{finding.detail}</div>}
      {finding.file && (
        <button
          onClick={() => onJump(finding.file!, finding.line)}
          className="mt-0.5 font-mono text-[10px] text-octo-brass hover:underline focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          {finding.file}{finding.line != null ? `:${finding.line}` : ""} ⟶
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test + full suite + typecheck — green.** Confirm `grep -nE "rgba\(|#[0-9a-fA-F]{3,8}" src/components/review/AiFindingCard.tsx` is empty.
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/AiFindingCard.tsx src/components/review/AiFindingCard.test.tsx
git commit -m "feat(g5): AiFindingCard — severity/category/title + jump-to-diff link"
```

---

## Task 5: `components/review/AiReviewPanel.tsx`

**Files:** Create `src/components/review/AiReviewPanel.tsx`, `src/components/review/AiReviewPanel.test.tsx`.

`ModelPicker` props (verified): `{ activeModel: string; onSelectModel: (id: string) => void; allowedProviders?: string[] }` — omit `allowedProviders` (any catalog model). `Loader2` from `lucide-react` (already used elsewhere). Collapsible via grid-rows; header has the `§ AI Review` toggle + a Review/▸ run control + ModelPicker. Running expands the body.

- [ ] **Step 1: Write the failing test:**
```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../lib/ipc", () => ({ ipc: { aiComplete: vi.fn() } }));
// ModelPicker hits IPC on mount; stub it to a no-op for this unit test.
vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }));
import { ipc } from "../../lib/ipc";
import { useAiReview } from "../../stores/aiReviewStore";
import { AiReviewPanel } from "./AiReviewPanel";

const okJson = JSON.stringify({ summary: "the change", findings: [{ severity: "high", category: "bug", title: "Boom", detail: "d", file: "a.ts", line: 2 }] });

beforeEach(() => {
  localStorage.clear();
  useAiReview.setState({ models: {}, reviews: {} });
  (ipc.aiComplete as any).mockReset();
});

describe("AiReviewPanel", () => {
  it("runs the review and renders findings", async () => {
    (ipc.aiComplete as any).mockResolvedValue({ text: okJson, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    const onJump = vi.fn();
    const { getByRole, getByText } = render(<AiReviewPanel workspaceId="w1" gitDiff="DIFF" onJump={onJump} />);
    fireEvent.click(getByRole("button", { name: /review this change/i }));
    await waitFor(() => expect(getByText("Boom")).toBeTruthy());
    expect(getByText("the change")).toBeTruthy();
    expect(ipc.aiComplete).toHaveBeenCalled();
  });
  it("shows nothing-to-review for an empty diff", () => {
    const { getByText } = render(<AiReviewPanel workspaceId="w1" gitDiff="   " onJump={() => {}} />);
    expect(getByText(/nothing to review/i)).toBeTruthy();
  });
  it("shows an error state on failure", async () => {
    (ipc.aiComplete as any).mockRejectedValue(new Error("API key not configured"));
    const { getByRole, getByText } = render(<AiReviewPanel workspaceId="w1" gitDiff="DIFF" onJump={() => {}} />);
    fireEvent.click(getByRole("button", { name: /review this change/i }));
    await waitFor(() => expect(getByText(/API key not configured/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run it — fails.**

- [ ] **Step 3: Implement:**
```tsx
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useAiReview, diffHash } from "../../stores/aiReviewStore";
import { AiFindingCard } from "./AiFindingCard";
import { ModelPicker } from "../ModelPicker";

export function AiReviewPanel({
  workspaceId,
  gitDiff,
  onJump,
}: {
  workspaceId: string;
  gitDiff: string;
  onJump: (file: string, line: number | null) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const model = useAiReview((s) => s.modelFor(workspaceId));
  const setModel = useAiReview((s) => s.setModel);
  const review = useAiReview((s) => s.reviewFor(workspaceId));
  const run = useAiReview((s) => s.run);

  const hasDiff = gitDiff.trim().length > 0;
  const stale = review.status === "done" && review.diffHash !== diffHash(gitDiff);

  const start = () => {
    if (!hasDiff) return;
    setCollapsed(false);
    void run(workspaceId, gitDiff);
  };

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          § AI Review
        </button>
        {review.status === "done" && (
          <span className="font-mono text-[9px] text-octo-mute">
            {review.result!.findings.length} finding{review.result!.findings.length !== 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <ModelPicker activeModel={model} onSelectModel={(m) => setModel(workspaceId, m)} />
          {hasDiff && review.status !== "running" && (
            <button
              onClick={start}
              className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              {review.status === "done" ? "Re-review" : "Review this change"}
            </button>
          )}
        </span>
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-[var(--dur-standard)]"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden px-3 pb-3">
          {!hasDiff ? (
            <p className="text-[11px] text-octo-mute">Nothing to review.</p>
          ) : review.status === "running" ? (
            <div className="flex items-center gap-2 text-[11px] text-octo-sage">
              <Loader2 size={12} className="animate-spin" /> Reading the change…
            </div>
          ) : review.status === "error" ? (
            <p className="text-[11px] text-octo-rouge">
              {review.error}{" "}
              <button onClick={start} className="text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass">Retry</button>
            </p>
          ) : review.status === "done" ? (
            <div className="space-y-1.5">
              {stale && (
                <button onClick={start} className="font-mono text-[10px] text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass">
                  diff changed — re-run ⟶
                </button>
              )}
              <p className="text-[11px] leading-[1.5] text-octo-sage">{review.result!.summary}</p>
              {review.result!.findings.map((f, i) => (
                <AiFindingCard key={i} finding={f} onJump={onJump} />
              ))}
              {review.result!.findings.length === 0 && (
                <p className="text-[11px] text-octo-verdigris">No issues found.</p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-octo-mute">Run an AI review of the current change.</p>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test + full suite + typecheck — green.** Hex-grep the file empty.
- [ ] **Step 5: Commit.**
```bash
git add src/components/review/AiReviewPanel.tsx src/components/review/AiReviewPanel.test.tsx
git commit -m "feat(g5): AiReviewPanel — collapsible Companion section, model picker, states"
```

---

## Task 6: Wire into `Companion.tsx` + `App.tsx`

**Files:** Modify `src/components/Companion.tsx`, `src/App.tsx`.

- [ ] **Step 1: Companion props + render.** In `src/components/Companion.tsx`: import the panel (`import { AiReviewPanel } from "./review/AiReviewPanel";`); add two optional props to `interface Props`:
```ts
  reviewGitDiff?: string;
  onJumpToFile?: (file: string, line: number | null) => void;
```
destructure them in the component params, and replace the review branch:
```tsx
        {mode === "review" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {workspaceId && reviewGitDiff !== undefined && (
              <AiReviewPanel
                workspaceId={workspaceId}
                gitDiff={reviewGitDiff}
                onJump={onJumpToFile ?? (() => {})}
              />
            )}
            {fileTree && <CompanionFileTree {...fileTree} />}
          </div>
        )}
```
(The old line was `{mode === "review" && fileTree && <CompanionFileTree {...fileTree} />}`.)

- [ ] **Step 2: App wiring.** In `src/App.tsx`, at the `<Companion ... />` usage (~line 1545), pass:
```tsx
            reviewGitDiff={gitDiff}
            onJumpToFile={(file) => navigateToFile(file, "diff")}
```
`gitDiff` is the Review diff state already in scope; `navigateToFile(path, "diff")` exists (App.tsx:922). The `line` arg is accepted but not used yet (best-effort file-level jump; line-precise highlight is deferred per the spec).

- [ ] **Step 3: Verify.**
```bash
npm run typecheck && npx vitest run
git diff main -- src | grep -nE "#[0-9a-fA-F]{3,8}" || echo "hex clean"
```
Expected: typecheck clean; all tests green; hex-clean (the only inline `rgba` are pre-existing in non-G5 files).

- [ ] **Step 4: Build smoke** (per the cache gotcha):
```bash
rm -rf dist src-tauri/target/release/bundle && touch src-tauri/src/lib.rs
npm run build           # vite production bundle (frontend)
(cd src-tauri && cargo test 2>&1 | tail -6)   # 5 pre-existing PTY failures only
```
Manual (optional `.app`): enter Review on a workspace with changes → Companion shows "§ AI Review" above the file tree → set a model → "Review this change" → loading → findings render with the mini-summary → click a finding's `file:line ⟶` jumps the center diff to that file. Empty diff → "Nothing to review". No API key → error toast/text from the backend.

- [ ] **Step 5: Commit.**
```bash
git add src/components/Companion.tsx src/App.tsx
git commit -m "feat(g5): wire AiReviewPanel into the Companion review section (App threads gitDiff + jump)"
```

---

## Self-Review (planning)

- **Spec coverage:** §3 primitive → T1 (`ai_complete` + ipc, cost computed+returned, DB-record deferred per the type reality); §4 data model + prompt + parse → T2; store/freshness/model → T3; §5 components → T4 (card) + T5 (panel) + T6 (Companion/App wiring); §6 behaviors (manual trigger, cache-by-hash, loading→findings, model picker default sonnet-4-6, findings→diff via `navigateToFile`, empty-diff) → T5+T6; §7 error handling → T3 (store error) + T5 (error UI) + parse-throw in T2; §8 testing → each task is TDD. Deferred items (agent mode, streaming, C/D/E, DB cost-record, line-precise jump) are explicitly out of scope.
- **Type consistency:** `AiFinding`/`AiReviewResult`/`Severity`/`Category` defined in T2, consumed in T3/T4/T5; `useAiReview`/`diffHash`/`modelFor`/`reviewFor`/`run`/`setModel` defined in T3, used in T5; `ipc.aiComplete` (camelCase result `{text,inputTokens,outputTokens,costUsd}`) defined in T1, used in T3; `AiCompleteResult` uses `#[serde(rename_all="camelCase")]` so the wire shape matches the ipc type; `ModelPicker { activeModel, onSelectModel }` used in T5; Companion props `reviewGitDiff`/`onJumpToFile` defined+passed in T6.
- **Independence:** reuses `resolve_provider`/`LlmProvider`/`token_engine`/`ModelPicker`/`navigateToFile` read-only; the only edits to shared files are additive: `commands.rs`/`lib.rs` (new command), `ipc.ts` (new method), `Companion.tsx`/`App.tsx` (new props + render). No edits to the diff rendering (G3), staging (G4), or editor (G1).
- **Known deferral:** the AI cost is returned but not written to `token_events` (the `record` API needs a `TokenEngine` instance + `TokenEvent`); the panel can surface `costUsd` directly. DB-recording is a small follow-up.
