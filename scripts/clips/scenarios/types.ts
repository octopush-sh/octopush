// Scenario contract for the demo-clip harness (docs/WHATS-NEW.md §4).
//
// A scenario is plain data: what each Tauri command returns, plus the
// localStorage the app finds on boot. The harness (src/clips/) serves it
// through @tauri-apps/api/mocks, so the REAL frontend renders against it.
// Fixture values are typed against src/lib/types.ts / src/lib/ipc.ts with
// `satisfies`, so `npm run typecheck` catches shape drift.

/** Arguments the frontend passed to `invoke` (camelCase keys). */
export type CommandArgs = Record<string, unknown>;

/** A fixed value, or a function of the invoke args. A thrown error rejects the invoke. */
export type CommandHandler = ((args: CommandArgs) => unknown) | string | number | boolean | null | object;

export interface Scenario {
  /** kebab-case name — what `scenario:` in a changeset and `?scenario=` refer to. */
  name: string;
  /** One line, for `scripts/clips/README.md` and `--verbose`. */
  description: string;
  /** Seeded into localStorage (after clearing it) before the app module loads. */
  localStorage?: Record<string, string>;
  /** Command name → result. Anything absent falls back to a safe default. */
  commands: Record<string, CommandHandler>;
}
