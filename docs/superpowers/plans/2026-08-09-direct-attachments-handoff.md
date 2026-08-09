# Handoff — what's left of "Direct as rich as Talk"

**Written:** 2026-08-09, at the end of the session that shipped the Companion
full-height move, the title-bar project name, Review's reveal-in-tree, and
DIRECT's `@file` / `/skill` references (PR #199, branch
`claude/octopush-companion-flush`).

Two pieces of the director's original ask were deliberately **not** built. This
document is what a fresh session needs to finish them without re-deriving the
ground.

---

## The original ask, and what it turned into

> "En el modo Direct, en la sección donde se escribe el prompt para el pipeline
> o en la descripción de los agentes o roles, no se puede actualmente pegar
> imágenes o referenciar archivos… debería tener tal nivel de versatilidad para
> que al momento de interactuar con el pipeline se pueda pegar imágenes,
> referenciar archivos del codebase, referenciar skills, plugins o comandos."

Split into four, by cost:

| Piece | State |
|---|---|
| `@file` in the run brief | **Shipped** — `src/components/direct/RichPromptTextarea.tsx` |
| `/skill` in the brief, resolved at stage start for both substrates | **Shipped** — `src-tauri/src/skills/mod.rs` + both runners |
| **Images in the brief** | **Not built.** Schema + IPC + orchestrator work. §1 below |
| **`@file` in the role editor** | **Not built, and blocked on a product decision.** §2 below |

The director's stated priority was that *"cuando llegue el momento en que ese
rol se active en la ejecución del pipeline, sepa qué skill es y cargue sus
instrucciones"* — that part is done and is the thing to preserve when touching
any of the code below.

---

## 1 · Images in the DIRECT brief

### Why it wasn't bundled

TALK carries images end-to-end already; DIRECT has no channel for them at all.
`create_run` takes a plain `task: String`. Adding images is a **schema
migration plus IPC plus orchestrator** change, which is a different kind of
risk from the frontend-only work around it — it was cut so the rest could ship
verified rather than half-plumbed.

### What already exists (do not rebuild)

- `LlmBlock::Image { media_type, data }` and `LlmContent::Multimodal(Vec<LlmBlock>)`
  in the provider layer. **The hard part is done.**
- `chat_engine.rs` — the working precedent for turning attachments into blocks.
  Look at the `request.attachments` loop that rewrites the last user turn into
  `LlmContent::Multimodal`, including its warning when the last message is not
  a user turn. Mirror that shape.
- `chat_engine::Attachment { media_type, data }` (base64) — reuse the struct or
  a twin of it; the frontend already produces exactly this shape via
  `src/lib/attachments.ts` (`fileToAttachment`) and the paste/drop/picker
  handlers in `src/components/chat/Composer.tsx`.
- `src/components/chat/AttachmentTray.tsx` — the thumbnail strip, reusable.

### The work

1. **DB** — `runs` gains an attachments column (JSON array of
   `{mediaType, data}`), plus a migration. Watch the size: base64 images in a
   row that is read on every run list is a real cost. Consider storing them in
   a side table keyed by `run_id`, loaded only when a stage runs. Whichever
   way, `list_active_runs` / the runs list must **not** start dragging image
   payloads into every poll.
2. **IPC** — `create_run` takes `attachments: Option<Vec<Attachment>>`;
   `src/lib/ipc.ts` `createRun` signature follows. `DirectCanvas` →
   `PipelineSetup.onBegin` → `runsStore.begin` all thread it.
3. **Orchestrator** — `StageContext` already carries a resolved-at-stage-start
   field (`skills`, added this session); add `attachments` the same way, read
   in `run_stage_once` where `skills` is resolved. Then in `runner.rs`
   (API substrate) build the user turn as `Multimodal` when attachments exist.
4. **CLI substrate** — `cli_runner.rs` has no multimodal channel: the CLI is
   spawned with a text prompt. Decide explicitly (and tell the director):
   either write the images to temp files in the worktree and reference their
   paths in the prompt, or state that images are API-substrate only and make
   the launcher say so when the chosen crew has CLI stages. **Do not silently
   drop them** — that is the failure mode to avoid.
5. **Frontend** — paste/drop/picker on the brief. `RichPromptTextarea` is the
   natural host; it currently owns only text, so attachments should live in
   `PipelineSetup` beside it (mirroring how `Composer` owns the tray) rather
   than being buried in the shared input.

### Verification note

`cargo test --lib` in this container: **695 pass**; 11 failures in
`pty_client`, `talk_shell::e2e`, `tests::pty_manager_reattach_tests` and
`chat_engine::tests::sandboxed_write_file_refuses_paths_outside_the_workspace`
are **environmental** — the PTY daemon binary does not compile on Linux
(macOS-only `libc::proc_pidinfo`), and they fail identically on a clean tree
(verified by stashing). Don't chase them. GTK dev libs must be installed for
`cargo check` to run at all here:
`apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`.

---

## 2 · `@file` in the role editor — blocked on a decision

`RoleEditor` (`src/components/RoleEditor.tsx`, opened from `PipelineBuilder`)
has a hero prompt textarea and a per-stage instructions field. Dropping
`RichPromptTextarea` in is ~5 lines. **Don't** — not until the director answers
this:

> **A role is global.** It is reused across every project and workspace. A file
> path referenced inside a role's prompt is only valid in the worktree it was
> written in; in the next project it points at nothing.

`RoleEditor` doesn't even receive a `workspacePath` today, and neither does
`PipelineBuilder` — that is a symptom of the scoping, not an oversight.

Options to put to the director:

1. **Roles stay global; no `@file` in them.** `/skill` only (skills resolve by
   name against whatever worktree is running, so they travel correctly).
2. **Roles gain a project scope** — a real data-model change (`roles` table
   gains a nullable `project_id`, palette filters by it, built-ins stay global).
3. **Allow the reference and accept it can dangle** — cheapest, and the agent
   simply fails to find the file elsewhere. Honest only if the editor says so.

Note that **`/skill` in role prompts already works end-to-end**: skill
resolution reads the brief *plus that stage's role prompt and instructions*
(`orchestrator/mod.rs`, where `reference_text` is assembled). So option 1 is
already implemented — it only needs the picker UI in the editor, which needs no
`workspacePath` if it lists skills from the *active* workspace at edit time.

---

## Design decisions already made (don't relitigate)

- **Mode band**: switcher centred over the canvas column in a `1fr/auto/1fr`
  grid, status tail in the right track. The Companion never hosts it again.
- **Companion**: sibling of `WorkspaceRail`, full height, flush right, one
  `border-l` hairline. The ContextHeader spans the middle column only.
- **Review**: the tree **never** follows the editor. Marking the open row is
  automatic; moving the tree is on demand (breadcrumb `⌖ Reveal` / `⌘⇧E`).
  Revealing must `fetchChildren` each ancestor — expanding alone does not load
  a folder in this tree — and must clear an active filter.
- **Skill references**: resolved at stage start, never expanded into the brief
  text at creation time. Both substrates receive `# Active skill: <name>` +
  body appended to the composed system prompt.
- **Title bar**: project name rides beside the wordmark, mono/caps/sage,
  truncating, so the centred mark cannot be pushed off centre.

## Where the mockups live

Live, interactive, published this session:

- Mode-selector placement studies — five options, C shipped
- Companion floor-to-ceiling A/B
- The three decisions (title bar · Direct references · Review reveal)

They are Claude artifacts, not in-repo. Ask the director for the links if the
visual intent is unclear; the FEATURES entries describe the shipped result.
