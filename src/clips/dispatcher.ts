// IPC dispatcher for the demo-clip harness: scenario handlers first, then
// safe defaults for anything the scenario doesn't cover. Every call is
// counted, and commands that fell through to a default are listed, so the
// recorder's `--verbose` shows exactly which fixtures are missing.
import type { CommandArgs, Scenario } from "../../scripts/clips/scenarios/types";

/** What a command nobody fixtured returns. Shaped by naming convention so the
 *  common read paths (`list_*` → array, `is_*` → false) don't crash a store. */
export function defaultFor(cmd: string): unknown {
  const name = cmd.includes("|") ? cmd.slice(cmd.indexOf("|") + 1) : cmd;
  if (cmd.startsWith("plugin:updater|")) return null; // no update available
  if (cmd === "plugin:window|scale_factor") return 1;
  if (cmd === "plugin:window|inner_size" || cmd === "plugin:window|outer_size") return { width: 1280, height: 800 };
  if (cmd === "plugin:window|inner_position" || cmd === "plugin:window|outer_position") return { x: 0, y: 0 };
  if (cmd === "plugin:app|version") return "0.0.0-demo";
  if (cmd === "plugin:app|name") return "Octopush";
  if (/^(list|search)_/.test(name) || /_(list|summary|history)$/.test(name)) return [];
  if (/^(is|has|can)_/.test(name)) return false;
  return null;
}

export interface CallLog {
  /** command → number of invokes */
  calls: Record<string, number>;
  /** commands that were answered by `defaultFor` (no scenario fixture) */
  defaulted: string[];
  /** commands whose scenario handler threw */
  failed: string[];
}

export function createDispatcher(scenario: Scenario) {
  const log: CallLog = { calls: {}, defaulted: [], failed: [] };
  const handle = (cmd: string, args?: unknown): unknown => {
    log.calls[cmd] = (log.calls[cmd] ?? 0) + 1;
    if (Object.prototype.hasOwnProperty.call(scenario.commands, cmd)) {
      const h = scenario.commands[cmd];
      if (typeof h !== "function") return structuredClone(h);
      try {
        return h((args ?? {}) as CommandArgs);
      } catch (e) {
        if (!log.failed.includes(cmd)) log.failed.push(cmd);
        throw e;
      }
    }
    if (!log.defaulted.includes(cmd)) log.defaulted.push(cmd);
    return defaultFor(cmd);
  };
  return { handle, log };
}
