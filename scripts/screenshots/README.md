# Documentation screenshots

`capture.cjs` regenerates the screenshots embedded in the root [`README.md`](../../README.md) (`docs/screenshots/*.png`).

Octopush is a Tauri app — every IPC call goes through `invoke` from `@tauri-apps/api/core`, which calls `window.__TAURI_INTERNALS__.invoke(...)`. The harness runs the normal Vite dev server (frontend only) and injects a **mock `__TAURI_INTERNALS__`** (with seeded, representative data) via Playwright's `addInitScript`, so the real React UI renders against fake data — **no source changes, no Rust backend**. It then drives the UI (open a workspace, switch modes, open the pipeline builder) and captures each surface.

## Run it

```bash
# 1. Start the frontend dev server (in one terminal)
npm run dev            # serves http://localhost:1420

# 2. Make Playwright available (it is not a project dependency)
npm i -D playwright && npx playwright install chromium
#   …or reuse an existing install via NODE_PATH:
#   export NODE_PATH="$(dirname "$(npx --no-install playwright --version >/dev/null 2>&1; \
#     node -p "require.resolve('playwright')")")/.."

# 3. Capture
node scripts/screenshots/capture.cjs
```

Outputs `01-welcome.png … 05-builder.png` into `docs/screenshots/` at 1440×900 @2x.

## Maintaining it

The seed data lives at the top of `capture.cjs` and is shaped to match the TypeScript types in `src/lib/types.ts` / `src/lib/ipc.ts`. If a surface stops rendering after a refactor, the most likely cause is a changed IPC shape — update the corresponding mock case. The mock returns safe defaults (`null` / `[]`) for any command it doesn't explicitly handle.
