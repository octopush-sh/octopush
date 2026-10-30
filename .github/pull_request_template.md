<!-- Agent PRs: start the body with "Closes #<issue>" and add the `agent` label. -->

## What & why

## Tests

## Checklist
- [ ] CI green (typecheck, Vitest, cargo test/clippy, repo rules)
- [ ] `docs/FEATURES.md` updated if this is user-visible
- [ ] User-visible? A changeset in `whats-new/unreleased/<slug>.md` (release note + tip + demo steps) — see `docs/WHATS-NEW.md`
- [ ] Any `steps:` targets have `data-tour` ids in the UI
- [ ] No human-only paths touched (VISION.md §8), or the issue has `agent-ok`
