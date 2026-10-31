# Visual audit

Finds layout defects in the real frontend before users do (#313). It started
with #312: pipeline names spilling out of their cards on macOS. That bug only
shows in **WebKit**, the engine Octopush runs on, and only with real-world data.

## How it works

1. `audit.mjs` starts Vite and opens the demo harness (`clips.html`: the real
   App with Tauri IPC mocked from `scripts/clips/scenarios/`).
2. For each scenario × surface (`home` plus every name in
   `src/lib/tour/surfaces.ts`: modes, Settings tabs, Mission Control, Logbook,
   palette) it opens a fresh page, then at each window size takes a screenshot
   and runs the checks in `checks.mjs` inside the page.
3. Findings are merged into one entry per defect (fingerprint = check +
   surface + element selector) and written to `<out>/findings.json`.
4. `file.mjs` files them as `visual` issues (the nightly workflow does this):
   new → issue (at most 5 a night; while fewer than 2 `visual` issues are
   `ready`, new ones get `ready` for the builder); fixed and back → reopened;
   closed as *not planned* → never refiled.

| Check | Catches |
|---|---|
| `text-escapes` | Visible text drawn outside the card/box that holds it |
| `text-overlap` | Two unrelated lines of text drawn on top of each other |
| `text-cut` | Text clipped with no ellipsis |
| `page-scroll-x` | The window scrolls sideways |
| `unlabeled-control` | A button or link with no text, `title` or `aria-label` |

Text hidden under an opaque layer (a dialog, a popover) is ignored, so a
Settings dialog over the app doesn't count as an overlap. Mark a region that is
meant to break these rules (a terminal, a canvas) with `data-audit-ignore`.

## Design review

After the checks, `visual-audit.yml` hands the 1280×800 screenshots, `CLAUDE.md`
and `docs/design-system.md` to a Claude agent (the nightly reviewer's read-only
sandbox, brief in `design-brief.md`) for what rules can't see: spacing,
hierarchy, brass overuse, retired flourishes, copy. `file.mjs --design` keeps a
finding only if it points at a region inside one of tonight's screenshots and is
high or medium severity, and files at most 3 a night as `proposal`: an AI's
taste goes to the owner or PM, never straight to the builder.

## Run it

```bash
npm i --no-save playwright && npx playwright install webkit   # once
node scripts/visual-audit/audit.mjs                            # WebKit, stress data, 3 sizes
node scripts/visual-audit/audit.mjs --engine chromium --surface mode/direct --sizes 1024x700
node scripts/visual-audit/file.mjs .visual-audit/findings.json --dry-run
```

Screenshots land in `.visual-audit/shots/` (git-ignored). Exit code: 0 clean,
1 findings, 2 the audit itself failed.

## When a layout bug escapes

Don't add a specialist; teach the audit. Add the data that would have shown it
to `scripts/clips/scenarios/stress.ts`, or a check to `checks.mjs` (with a test
in `visual-audit.test.mjs` for anything pure). Each escaped bug makes the next
night's audit stricter.
