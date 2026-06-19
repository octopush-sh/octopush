/** Detect a `$`-direct / `/run` command in composer input.
 *
 * Returns the command to execute (LLM bypassed), or `null` when the input is a
 * normal chat message. Two equivalent triggers:
 *   - `$ <cmd>`   — a space after `$` is required, so a question to the agent
 *                   that merely starts with `$` (e.g. "$PATH is empty, help")
 *                   isn't intercepted.
 *   - `/run <cmd>` — explicit alias, discoverable via the `/` menu.
 *
 * A leading `\$` is an escape hatch (handled by the caller) for sending literal
 * `$…` text to the agent; it is NOT treated as a command here.
 */
export function parseShellCommand(input: string): string | null {
  const t = input.trim();
  if (t.startsWith("\\$")) return null; // escaped — literal message
  const run = /^\/run\s+([\s\S]+)$/.exec(t);
  if (run) return run[1].trim();
  const dollar = /^\$\s+([\s\S]+)$/.exec(t);
  if (dollar) return dollar[1].trim();
  return null;
}
