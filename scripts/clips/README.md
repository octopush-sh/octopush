# Demo clips — recorder and scenarios

The clip recorder makes the short silent `<slug>.webm` shown in a What's new tip
(contract: [`docs/WHATS-NEW.md`](../../docs/WHATS-NEW.md) §1, §4, §5). It runs the
**real frontend** in headless Chromium with Tauri IPC mocked from a scenario fixture,
performs the changeset's `steps`, and records the screen.

```bash
npm run clips:record -- <version|unreleased> [--slug <s>] [--force] [--verbose]
#   e.g. npm run clips:record -- 0.4.89            # after `whats-new.mjs collect 0.4.89`
#        npm run clips:record -- unreleased --slug run-history-opt-in --verbose
```

| Flag | Meaning |
|---|---|
| `--slug <s>` | Only this changeset. |
| `--force` | Re-record even if `<slug>.webm` already exists. |
| `--verbose` | Vite logs, each step, encode attempts, and **IPC coverage**: every command the app invoked that no scenario fixture answered. |
| `--from <dir>` | Read changesets from another directory (clips are written there). Handy for trying a draft changeset outside the repo. |
| `--keep-raw` | Also keep Playwright's untrimmed recording as `<slug>.raw.webm`. |

A changeset is recorded when it has `area: app`, `steps`, and no clip yet. The clip is
written next to the `.md`; **nothing is committed** — the release routine (or you)
decides. Exit code is 1 if any selected clip failed; the release routine treats that as
"ship without clips".

## Requirements

- **Playwright** — not a project dependency. On a Mac:
  `npm i --no-save playwright && npx playwright install chromium`.
- **ffmpeg** (optional, recommended) — trims the blank lead-in and re-encodes to VP9,
  1280 wide, starting at ~800 kbps / 30 fps and stepping down fps then bitrate until the
  file is ≤ 1.5 MB. If it can't fit, the clip is skipped with a warning. Without ffmpeg
  the raw recording is kept only if it already fits.

## How it works

1. `record.mjs` starts Vite (dev server, free port) and opens
   `clips.html?octo-record=1&scenario=<name>`. `clips.html` → `src/clips/entry.tsx` is a
   harness entry: it is never part of `vite build` (which builds `index.html` alone).
2. The harness clears localStorage, seeds the scenario's keys, installs
   `mockWindows("main")` and `mockIPC(…, { shouldMockEvents: true })` from
   `@tauri-apps/api/mocks` (so `listen`/`emit` work and stores subscribe), **then**
   imports and mounts the real `App`.
3. Commands are answered by the scenario; anything else gets a safe default by name
   (`list_*` → `[]`, `is_*`/`has_*` → `false`, otherwise `null`; the updater reports no
   update) and is logged — that list is what `--verbose` prints.
4. Steps: if the app exposes `window.__octoTour.play` (the guided-tour runner), the
   recorder calls `play(steps, { mode: "record" })`. Otherwise it drives them itself:
   `open:` goes through the real surface registry (`src/lib/tour/surfaces.ts`), it waits
   for `[data-tour="<target>"]`, draws a caption + spotlight (`overlay.mjs`, styled only
   with the app's CSS tokens) and performs `click` / `hover` / `type`. Steps whose
   target never appears are skipped, as in the tour.
5. Video: 1280×800, recorded per changeset in its own browser context. A warm-up load
   runs first so Vite's compile time never lands in a clip.

`window.__octoClips` (harness → recorder): `ready`, `scenario`, `log` (`calls`,
`defaulted`, `failed`), `openSurface(name)`, `emit(event, payload)` to fire a backend
event at the app. `<html data-octo-record="1">` is set while recording, for UI that should
behave differently on camera.

## Scenarios

Plain TypeScript in [`scenarios/`](scenarios/), typed against `src/lib/types.ts` /
`src/lib/ipc.ts`, so `npm run typecheck` catches fixture drift. A changeset picks one
with `scenario:` (default: `default`).

| Name | State |
|---|---|
| `default` | Signed-in Pro user · project "octopush" with workspaces `main` and `run-history-sync` (active, Talk mode) · a finished 4-stage Direct run ($0.41 vs $1.87 baseline) · a 3-message Talk thread · Anthropic, OpenAI and Ollama configured. |
| `empty` | Fresh install — no projects (Welcome screen), signed out, free plan. |

Adding one: create `scenarios/<name>.ts` exporting a `Scenario` (`types.ts`), register
it in `scenarios/index.ts`, and run a recording with `--verbose` to see which commands
still fall back to defaults. A command handler is a value, or `(args) => value` for
results that depend on the invoke arguments; throwing rejects the invoke.

## Tests

`node --test scripts/clips/lib.test.mjs` (changeset selection, encode-ladder
decisions; run in CI's repo-rules job) and `src/clips/dispatcher.test.ts` (Vitest).
Browser recording is deliberately not run in CI.
