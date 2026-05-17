# Phase 7 — Motion Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land the three signature motion moments from the spec that haven't been implemented yet — `brass rule grow`, `key phrase fade-in`, and `context-header name cross-fade`. The fourth motion moment (`mode glide`) already shipped in Mini-Phase 3.

After this phase, Atelier moves the way the spec describes: not bouncy, not flashy — calm, deliberate, with brass marking the moment.

**Architecture:** Define CSS `@keyframes` once in `src/styles.css` so every motion shares the same easing curves and timings (the `--ease-octo`, `--dur-*` variables from Phase 1 finally get used). Create a small `<BrassRule />` component that wraps the recurring static brass divider and animates it on mount. Add a key-phrase fade-in animation in `ChatMessage` for new assistant turns. Add a name-swap cross-fade in `ContextHeader` that fires when `workspaceName` changes.

**Tech stack:** Pure CSS animations (no JS animation library). The pattern is `className="animate-foo"` where `foo` is keyed off a CSS variable for the duration/easing, so timing stays consistent.

---

## Spec reference

`docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md` §5 (motion principles + signature animations table). Specifically:

| Motion | Duration | Easing | Source |
|--------|----------|--------|--------|
| Key phrase fade-in | 280ms ease-out, staggered | — | §5.2 |
| Brass rule reveal | 600ms cubic-bezier(.2,.8,.3,1) | `--ease-octo` | §5.2 |
| Workspace switch name cross-fade | 260ms ease-in-out | — | §5.2 |
| Mode glide | 320ms ease-in-out | — | §5.2 (DONE in MP3) |

---

## File structure

**Created**

| Path | Responsibility |
|------|----------------|
| `src/components/BrassRule.tsx` | Small component that renders the 28px brass-gradient divider with the grow-on-mount animation. Drop-in replacement for the static `<div className="h-px w-7" style={{ background: "linear-gradient(...)" }} />` instances scattered across the codebase. |

**Modified**

| Path | Why |
|------|-----|
| `src/styles.css` | Add `@keyframes` for `brassgrow`, `keyfade-eyebrow`, `keyfade-key`, `keyfade-body`, `keyfade-tool`, `namefade-out`, `namefade-in`. Wire them to existing Phase 1 `--ease-octo` / `--dur-*` variables. |
| `src/components/WelcomeScreen.tsx` | Swap the static brass rule for `<BrassRule />`. |
| `src/components/NewProjectFlow.tsx` | Swap the static brass rule for `<BrassRule />`. |
| `src/components/WorkspaceCreator.tsx` | Swap the static brass rule for `<BrassRule />`. |
| `src/App.tsx` | `RunEmptyState` and `ReviewEmptyState` use `<BrassRule />`. |
| `src/components/ChatView.tsx` | `EmptyState` uses `<BrassRule />`. |
| `src/components/ChatMessage.tsx` | Add staggered fade-in classes on assistant turns (`animate-keyfade-eyebrow` on the eyebrow, `animate-keyfade-key` on the key phrase, `animate-keyfade-body` on the body, `animate-keyfade-tool` on inline tool cards if any). |
| `src/components/ContextHeader.tsx` | When `workspaceName` changes, briefly fade the name out → swap → fade in (260ms ease-in-out cross-fade). |

**Not touched in Phase 7**

- `ModeSwitcher` (already animated in Mini-Phase 3).
- Canvas pane opacity transition (already in App.tsx via Mini-Phase 3).
- Hover lifts on rail / CTA buttons — deferred. Adding subtle hover motion across all clickable elements is a tasteful future polish but expands scope beyond the spec's four named moments.
- ToolCallCard expand/collapse — its rotation is already animated (transition: transform 150ms).

---

## Tasks

### Task 1: BrassRule component + keyframes

**Files:**
- Create: `src/components/BrassRule.tsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Add the keyframes to `src/styles.css`**

Read the current `src/styles.css`. Find the `:root` block that holds the brass-dim/ghost + ease/dur variables (added in Phase 1). After that block (before the body/html/xterm rules), append:

```css
/* ── Motion · Phase 7 signature animations ───────────────────── */

@keyframes brassgrow {
  from { width: 0; opacity: 0; }
  to   { width: 28px; opacity: 1; }
}

@keyframes keyfade-eyebrow {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes keyfade-key {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes keyfade-body {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes keyfade-tool {
  from { opacity: 0; transform: translateX(-8px); }
  to   { opacity: 1; transform: translateX(0); }
}

@keyframes namefade-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* Utility classes that wire keyframes to Phase 1 ease/dur variables. */
.animate-brass-grow {
  animation: brassgrow var(--dur-reveal) var(--ease-octo) forwards;
  width: 0;
}

.animate-keyfade-eyebrow {
  animation: keyfade-eyebrow 180ms ease-out forwards;
  opacity: 0;
}

.animate-keyfade-key {
  animation: keyfade-key var(--dur-standard) ease-out 80ms forwards;
  opacity: 0;
}

.animate-keyfade-body {
  animation: keyfade-body var(--dur-standard) ease-out 220ms forwards;
  opacity: 0;
}

.animate-keyfade-tool {
  animation: keyfade-tool var(--dur-standard) ease-out 320ms forwards;
  opacity: 0;
}

.animate-name-in {
  animation: namefade-in 260ms ease-in-out forwards;
}
```

Notes:
- `forwards` ensures the final state sticks after the animation ends (the element keeps its `opacity: 1` and final `transform`).
- The initial `opacity: 0` / `width: 0` declarations match the keyframe `from` state. This avoids a single-frame flash where the element renders fully visible before the animation starts.
- Stagger delays: eyebrow at 0ms, key at 80ms, body at 220ms, tool at 320ms. Total cascade ≈ 600ms — feels like a deliberate reveal, not a slideshow.

- [ ] **Step 2: Create `src/components/BrassRule.tsx`**

```tsx
// Brass-gradient divider that grows from 0 to 28px on mount.
// Replaces the recurring static <div className="h-px w-7" style={{ background:
// "linear-gradient(...)" }} /> pattern across entry flows + empty states.

interface Props {
  /** Extra margin via className. Pass Tailwind margin utilities. */
  className?: string;
}

export function BrassRule({ className = "" }: Props) {
  return (
    <div
      aria-hidden
      className={`animate-brass-grow h-px ${className}`}
      style={{
        background: "linear-gradient(90deg, var(--color-octo-brass), transparent)",
      }}
    />
  );
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: 64/64 pass. (BrassRule has no test — it's 8 lines of presentation.)

- [ ] **Step 5: Commit**

```bash
git add src/components/BrassRule.tsx src/styles.css
git commit -m "feat: BrassRule component + signature motion keyframes"
```

---

### Task 2: Swap static brass rules for `<BrassRule />`

**Files to modify:** 5 components that currently render a hand-rolled brass-gradient div.

- [ ] **Step 1: `src/components/WelcomeScreen.tsx`**

Find:
```tsx
      {/* Brass rule */}
      <div
        aria-hidden
        className="my-6 h-px w-7"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
```

Replace with:
```tsx
      {/* Brass rule */}
      <BrassRule className="my-6 w-7" />
```

Add the import at the top:
```tsx
import { BrassRule } from "./BrassRule";
```

- [ ] **Step 2: `src/components/NewProjectFlow.tsx`**

Find:
```tsx
        <div
          aria-hidden
          className="mt-10 h-px w-7"
          style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
        />
```

Replace with:
```tsx
        <BrassRule className="mt-10 w-7" />
```

Add the import: `import { BrassRule } from "./BrassRule";`

- [ ] **Step 3: `src/components/WorkspaceCreator.tsx`**

Same pattern as NewProjectFlow — find the brass rule at the bottom of the left pane and replace with `<BrassRule className="mt-10 w-7" />`. Add the import.

- [ ] **Step 4: `src/components/ChatView.tsx`**

Find in the `EmptyState` helper at the bottom of the file:
```tsx
      <div
        aria-hidden
        className="mt-2 h-px w-7"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
```

Replace with:
```tsx
      <BrassRule className="mt-2 w-7" />
```

Add the import: `import { BrassRule } from "./BrassRule";`

- [ ] **Step 5: `src/App.tsx`**

`ReviewEmptyState` (defined inline near the bottom of App.tsx) has the same hand-rolled rule. Find:
```tsx
      <div
        aria-hidden
        className="mt-2 h-px w-7"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
```

Replace with:
```tsx
      <BrassRule className="mt-2 w-7" />
```

Add the import: `import { BrassRule } from "./components/BrassRule";`

(`RunEmptyState` doesn't have a brass rule — only the heading + body + CTA. Leave it alone.)

- [ ] **Step 6: Verify nothing else uses the inline pattern**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
grep -rn 'linear-gradient(90deg, var(--color-octo-brass)' src/ --include="*.tsx" --include="*.ts"
```

Expected: only references inside `BrassRule.tsx` and maybe ChatMessage's `hr` markdown override (that one is data-driven from markdown content — leave it).

If anything else matches, swap it to `<BrassRule />`.

- [ ] **Step 7: Run typecheck + tests**

```bash
npm run typecheck
npm test
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: replace static brass rules with animated <BrassRule />"
```

---

### Task 3: Key-phrase fade-in cascade in ChatMessage

**Files:** Modify `src/components/ChatMessage.tsx`.

- [ ] **Step 1: Read the current file**

Locate the assistant render block (the `if (role === "user")` early return, then the assistant `return` statement). The structure currently is:

```tsx
return (
  <div data-role="assistant" className="flex flex-col gap-2">
    <div className="font-mono ...">— {modelDisplayName(model)}</div>
    {keyPhrase && (<ReactMarkdown ...>{keyPhrase}</ReactMarkdown>)}
    {body && (<div className="text-[13px] ...">...</div>)}
    {(model || ...) && <div className="font-mono ...">{...tokens}</div>}
  </div>
);
```

- [ ] **Step 2: Add animation classes to each child**

Wrap each child with the corresponding animate class. The cascade order is: eyebrow → keyPhrase → body → token meta.

Find the eyebrow div:
```tsx
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        — {modelDisplayName(model)}
      </div>
```

Replace with:
```tsx
      <div className="animate-keyfade-eyebrow font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        — {modelDisplayName(model)}
      </div>
```

Find the keyPhrase block:
```tsx
      {keyPhrase && (
        <ReactMarkdown
          components={{
            ...
            p({ children }) {
              return (
                <p className="font-serif italic text-[20px] leading-[1.15] tracking-[-0.005em] text-octo-ivory">
                  {children}
                </p>
              );
            },
          }}
        >
          {keyPhrase}
        </ReactMarkdown>
      )}
```

Wrap the entire `{keyPhrase && (...)}` in a div with the animation class:
```tsx
      {keyPhrase && (
        <div className="animate-keyfade-key">
          <ReactMarkdown
            components={{
              code({ children }) {
                return (
                  <code className="font-mono not-italic text-octo-brass">
                    {children}
                  </code>
                );
              },
              p({ children }) {
                return (
                  <p className="font-serif italic text-[20px] leading-[1.15] tracking-[-0.005em] text-octo-ivory">
                    {children}
                  </p>
                );
              },
            }}
          >
            {keyPhrase}
          </ReactMarkdown>
        </div>
      )}
```

Find the body block:
```tsx
      {body && (
        <div className="text-[13px] leading-[1.6] text-octo-sage">
          <ReactMarkdown components={markdownComponents}>{body}</ReactMarkdown>
        </div>
      )}
```

Add the animation class:
```tsx
      {body && (
        <div className="animate-keyfade-body text-[13px] leading-[1.6] text-octo-sage">
          <ReactMarkdown components={markdownComponents}>{body}</ReactMarkdown>
        </div>
      )}
```

Find the token meta div (the last one) and add the same body animation class so it fades in with the body:
```tsx
      {(model || inputTokens != null || outputTokens != null) && (
        <div className="animate-keyfade-body font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
          ...
        </div>
      )}
```

- [ ] **Step 3: Run typecheck + tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: clean. The ChatView.test.tsx tests render messages and assert text presence — those still pass because `forwards` ensures the final state is visible. RTL queries the final DOM after animations resolve (jsdom doesn't actually animate but the final classNames and styles are correct).

- [ ] **Step 4: Commit**

```bash
git add src/components/ChatMessage.tsx
git commit -m "feat: staggered key-phrase fade-in cascade (eyebrow → key → body)"
```

---

### Task 4: ContextHeader workspace-name cross-fade

**Files:** Modify `src/components/ContextHeader.tsx`.

- [ ] **Step 1: Read the current file**

```tsx
export function ContextHeader({ workspaceName, branch, gitStatus }: Props) {
  const unstaged = gitStatus?.changedFiles.length ?? 0;
  return (
    <div className="m-4 ...">
      <div>
        <div className="font-mono ...">Workspace</div>
        <div className="font-serif italic ...">{workspaceName}</div>
      </div>
      ...
    </div>
  );
}
```

- [ ] **Step 2: Apply a `key`-based remount animation**

The cleanest way to retrigger a CSS animation on prop change is to give the animated element a `key` whose value changes when the prop changes. React then unmounts the old element and mounts a new one — which triggers the `animate-name-in` keyframe.

Update the workspaceName span to:

```tsx
<div
  key={workspaceName}
  className="animate-name-in font-serif italic text-[15px] leading-tight tracking-[-0.005em] text-octo-ivory"
>
  {workspaceName}
</div>
```

The `key={workspaceName}` causes React to remount when the value changes. The `animate-name-in` keyframe (defined in Task 1) fades from `opacity: 0; translateY(2px)` to `opacity: 1; translateY(0)` over 260ms ease-in-out. On the first render (initial mount) it animates from the same state — so the header animates in cleanly on app load too.

- [ ] **Step 3: Run typecheck + tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: clean. ContextHeader.test.tsx asserts the workspace name is in the DOM — `forwards` keeps the final state visible.

- [ ] **Step 4: Commit**

```bash
git add src/components/ContextHeader.tsx
git commit -m "feat: ContextHeader workspace-name cross-fade on change"
```

---

### Task 5: E2E verification + report

**Files:** none.

- [ ] **Step 1: Full sweep**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git log --oneline -6
npm run typecheck && npm test
cd src-tauri && cargo test 2>&1 | grep "test result.*passed" | head -3
```

Expected: typecheck clean, 64/64 frontend tests, 39/39 Rust tests.

- [ ] **Step 2: Boot dev server briefly**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run dev 2>&1 | head -10
```

Expected: Vite ready.

- [ ] **Step 3: Visual verification (user)**

User boots the production build. Expected motion:

- **Brass rules grow on entry**: visible on Welcome screen (between tagline and CTA), on NewProject wizard left pane, on NewWorkspace wizard left pane, on ChatView's empty state, on Review mode's empty state. Each rule visibly grows from width 0 to 28px over ~600ms with the Atelier easing curve.
- **Key phrase cascade**: when the model responds in chat, the eyebrow `— Sonnet 4.6` appears first (180ms fade), then the italic-serif key phrase slides up + fades in (280ms ease-out, 80ms delay), then the markdown body fades in (220ms delay), then the token meta. Total cascade ≈ 600ms.
- **Workspace name cross-fade**: clicking a different workspace in the rail makes the ContextHeader's workspace name briefly fade out + back in (~260ms). On first app load, it fades in cleanly too.

- [ ] **Step 4: Report blockers**

If a brass rule looks janky (e.g., flashes full size for a frame before animating), or the key-phrase cascade is too slow/fast for taste, tune the delays in `styles.css` and commit `fix: <surface> motion timing`.

---

## Self-review

**Spec coverage (§5):**
- Brass rule grow ✓
- Key phrase fade-in cascade ✓
- Workspace name cross-fade ✓
- Mode glide — already in Mini-Phase 3, so 4/4 signature moments are live after Phase 7.

**Type/consistency:**
- All keyframes reference Phase 1 CSS variables (`--ease-octo`, `--dur-*`).
- `BrassRule` props minimal: just optional `className` for layout margins.
- `key={workspaceName}` is a deliberate React anti-pattern only used to retrigger animations. Acceptable for one rare prop change (workspace switching is infrequent vs. message streaming).

**Risks:**
- The key-phrase cascade plays on every assistant message render. During fast successive messages (e.g., quick back-and-forth), the animations might overlap visually. Mitigation: cascade total ≈ 600ms which is shorter than user reading time of any non-trivial message. Acceptable.
- For VERY long chat histories loaded at once (e.g., 50 messages on workspace switch), all 50 ChatMessage components mount simultaneously → all animations play in parallel. This could look like a wave on workspace load. Mitigation: animation is opacity-only on most elements, so it just fades the whole timeline in once. Subjectively fine.
- BrassRule's `width: 0` initial state means before the animation starts, the rule isn't visible. If JS is throttled and React renders before CSS animation begins, you might see a 1-frame width:0 element. `forwards` + the initial CSS declaration prevent visible flashing.

**Phase 7 ships when:**
- 4 commits land on the branch.
- typecheck + tests pass.
- Visual smoke confirms brass rules grow, key phrases cascade, workspace name cross-fades.

**After Phase 7, the full Atelier redesign is complete (Phases 1–7 + Mini-Phase 3 + the chat tool-card structural fix).**
