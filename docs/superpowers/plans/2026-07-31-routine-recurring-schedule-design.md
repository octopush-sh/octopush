# Routines — versatile recurring schedules (Days × Times)

**Date:** 2026-07-31 · **Surface:** Routines (scheduled crews, Pro) · **Feature key:** `routines.scheduled` (no new gate)

Today a routine fires on `interval` (every N seconds) or `daily` (at HH:MM). Users need more: specific **days of the week** (Mon/Wed/Fri), a **single date**, and a **windowed cadence** ("every hour, 9am–3pm"). This adds a third schedule kind, **`recurring`**, that expresses all of these as two orthogonal choices — **which days** × **at what times** — without turning configuration into cron-hell.

## The insight that makes this cheap

The entire scheduler rests on one pure function: `next_due(kind, spec, after) → "next fire (UTC)"`. The tick, catch-up, `list_due_routines`, fixed/fresh, and the `fire_condition` gate **only** call it. So all the new versatility lives behind `next_due` + `validate_schedule`; the scheduler machinery is untouched. `interval`/`daily` stay exactly as-is (backward compatible; existing routines never change).

## Data model (no DB migration)

`schedule_kind = "recurring"`; `schedule_spec` holds a JSON string (the `spec` column is already TEXT). Typed on the Rust side:

```jsonc
{
  "days": { "kind": "weekly", "set": [1,3,5] }   // ISO 1=Mon … 7=Sun; non-empty
        | { "kind": "date",   "date": "2026-08-15" },  // one-shot
  "time": { "kind": "once",   "at": "09:00" }
        | { "kind": "window", "start": "09:00", "everyMinutes": 60, "end": "15:00" }
}
```

- **Days**: `weekly{set}` covers *every day* (all 7), *weekdays* (1–5), and *specific weekdays* (any subset). `date` is a one-shot.
- **Times**: `once{at}` or `window{start, everyMinutes, end}` (fires `start, start+every, … ≤ end`).

The three asks map directly: Mon/Wed/Fri 9am = `weekly[1,3,5]`+`once 09:00`; a specific date = `date`+`once`; 9am hourly for 6h = `weekly[all]`+`window 09:00→15:00 every 60`.

## `next_due` for recurring

From `after`, scan forward day-by-day (bounded, ≤400 days): for the first **active** day, list that day's fire instants (local, DST-safe via the existing `local_at`) and return the earliest **strictly after `after`**; if none that day, continue to the next active day. A `date` whose day is already past → `None` (the one-shot is complete → the routine goes un-due and auto-disables via the existing zombie path, or simply never fires again). Purely deterministic; unit-tested against fixed instants.

**Preview** (the UX cornerstone): a new `next_n_due(kind, spec, after, n)` iterates `next_due` n times (advancing the cursor), exposed via a **`preview_routine_schedule(kind, spec, count)`** Tauri command (no side effects, ungated) so the editor's "next runs" list uses the **real** engine — no second implementation to drift.

## Validation

`validate_schedule` for `recurring`: parse (clear error on malformed JSON); `weekly.set` non-empty & ⊆ 1..7; `date` parses; `once.at` valid HH:MM; `window` start/end valid HH:MM, `end ≥ start`, and **`everyMinutes ≥ 15`** (the quota-safety floor, analogous to interval's ≥60s; caps a window at ≤96 fires/day).

`validate_routine` gains the **spec** (signature change, both callers updated) so the **fresh⇒≤1×/day** rule generalizes: a `fresh` routine is allowed only when it fires at most once per day — `daily`, or `recurring` with `time.kind=="once"` (any days). `fresh`+`interval` and `fresh`+`recurring{window}` are rejected (a new worktree per fire, no reaper yet). Relaxes when the retention reaper lands.

## MCP parity

`create_routine`/`update_routine` (`ROUTINE_INPUT_SCHEMA`): `scheduleKind` enum gains `"recurring"`; `scheduleSpec`'s description documents the JSON shape + an example. No new `RoutineInput` field (the spec is still the string column). The structured JSON is more legible to an agent than cron. Same shared validators — no drift. Tests: a recurring create round-trips + a bad recurring spec is rejected.

## Frontend

- **`routineForm.ts`**: `RoutineDraft` gains recurring fields (`recurDays:number[]`, `recurUseDate`, `recurDate`, `recurTimeMode:"once"|"window"`, `recurAt`, `recurStart`, `recurStep`, `recurEnd`). `draftFromRoutine` parses the recurring JSON; `draftToInput` serializes + validates it (and enforces fresh⇒once). `scheduleSummary` gains the recurring sentence (the natural-language line, with the brass `&` between the last two days) — reused in the list row and the editor.
- **`RoutinesPane.tsx`**: the schedule-kind Listbox gains **"Custom…"** (→ recurring); the simple `Daily`/`Every` paths stay. When Custom: **preset chips** (Every day · Weekdays · Days of week · Time window · On a date) → **day chips** (Mo–Su toggles, or a date field) × **time mode** (segmented Once / Window with the every/from/to fields) → the **live summary** (serif, brass `&`) → the **"Next runs" preview** (mono, via `preview_routine_schedule`, debounced). Contextual amber note when Window+fresh is impossible. All Atelier tokens/motion; UI copy English. Mirrors the approved Companion mockup.
- **`ipc.ts`**: `scheduleKind` union gains `"recurring"`; add `previewRoutineSchedule`.

## Tests

- Rust (`routines.rs`/`tests.rs`): recurring next_due — weekly subset picks the right next weekday; window enumerates `start…end` and rolls to the next active day; a past `date` → `None`; DST day still fires once; `next_n_due` returns N distinct ascending instants. `validate_schedule` — non-empty set, range, `everyMinutes≥15`, `end≥start`, malformed JSON. `validate_routine` — fresh+recurring{once} ok, fresh+recurring{window} rejected.
- MCP (`tools.rs`): recurring create round-trips the spec; bad spec rejected.
- Frontend (`routineForm.test.ts`): draft↔wire round-trip for weekly/date/window; summary strings for the three canonical cases; fresh+window rejected.

## Docs

`docs/FEATURES.md` (the Routines entry + the MCP scheduleKind), `docs/octopush-mcp.md` (recurring spec in the routine authoring contract). If the day-chip/segmented pattern is new, note it in `docs/design-system.md`.

## Out of scope

Cron import (an "advanced/paste" affordance can wrap the same spec later); per-fire timezones (machine-local, like `daily` today); sub-15-min windows; monthly/"nth weekday" recurrences (the model extends to them but they're not asked for).
