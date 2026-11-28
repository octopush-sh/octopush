// Settings → Privacy — a statement of what stays local and what leaves, plus
// the Quiet Claude Code opt-in (#703). Every line here must stay EXACTLY
// true: when a feature adds a new outbound destination, add it to OUTBOUND in
// the same change (the website quotes this copy).
import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import { PaneHeader, ToggleRow } from "./shared";

/** Inline file path inside body copy: plain content, so ivory mono on the
 *  onyx code chip (as in What's New) — never brass, which stays on the
 *  eyebrow and the active nav row. Exported for the test. */
export const PATH_CHIP_CLASS = "rounded bg-octo-onyx px-0.5 font-mono text-[12px] text-octo-ivory";

/** Every place this app sends traffic. Exported for the copy test. */
export const OUTBOUND: readonly string[] = [
  "AI providers you configure — Anthropic, OpenAI-compatible endpoints, local models.",
  "Clerk for sign-in and Dodo Payments for checkout, when you use your account.",
  "Octopush's sync service, only if you turn on sync in Account.",
  "A webhook URL you set in Notify me elsewhere, only if you turn it on or send a test — a fixed label, the project's name and the mission's title (the start of its task), never code, diffs, the crew's questions or agent output.",
  "Integrations you connect — Jira, Epiku, GitHub, a LiteLLM gateway, MCP servers — and your git remotes.",
  "Update checks — octopush.sh/update/latest.json and GitHub releases.",
  "LiteLLM's public pricing table on GitHub, when you refresh pricing.",
];

/** Third-party tools Octopush launches but doesn't control. */
export const AGENT_CLI_NOTE =
  "Agent CLIs Octopush launches for you (Claude Code, Codex) talk to their own services and follow their own telemetry policies.";

/** The opening words of `AGENT_CLI_NOTE`, set in the lead-in voice like every
 *  other item's opening. Styling only: the sentence is still rendered whole,
 *  from the constant above. */
export const AGENT_CLI_LEAD_IN = "Agent CLIs";

/** The data inventory is a real list: one native marker for every item, in
 *  a 16px gutter, so a wrapped line hangs under the text and never under the
 *  marker. The marker takes the item's own colour. Exported for the test. */
export const INVENTORY_LIST_CLASS =
  "list-disc space-y-2 pl-4 text-[13px] leading-[1.6] text-octo-sage";
/** The outbound destinations: the same list, one level in. */
export const OUTBOUND_LIST_CLASS = "mt-1 list-disc space-y-1 pl-4";
/** Every item opens with its lead-in in the serif voice. */
export const LEAD_IN_CLASS = "font-serif text-octo-ivory";

/** The variable "Quiet Claude Code" sets on crew stages and Routines (#703). */
export const QUIET_ENV = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1";

/** The toggle's label and helper text — the owner-approved copy (#703),
 *  verbatim. The helper's `{env}` is rendered as a code chip. */
export const QUIET_LABEL = "Quiet Claude Code in crews and Routines";
export const QUIET_HELP_BEFORE = "Crew stages and Routines start Claude Code with ";
export const QUIET_HELP_AFTER =
  ". Claude Code then skips its auto-updates, telemetry, error reporting, release notes and availability checks. Features that need feature-flag fetching, such as Remote Control, don't work in those sessions. Your model requests to Anthropic still go out as usual. Run terminals are not affected.";

/** What Claude Code stages may send when the toggle is off (#703), verbatim. */
export const QUIET_OFF_NOTE =
  "When this is off, Claude Code in crew stages and Routines can also make its own nonessential calls (auto-update checks, telemetry, error reports), as described in Claude Code's documentation.";

export function PrivacyPane() {
  return (
    <>
      <PaneHeader
        eyebrow="Privacy"
        title="What stays, what leaves."
        subtitle="Your work stays on this Mac, unless you turn on sync. Requests to AI providers go straight from this machine to the provider, never through Octopush."
      />

      <ul className={INVENTORY_LIST_CLASS} data-testid="privacy-inventory">
        <li>
          <span className={LEAD_IN_CLASS}>Stored on this Mac:</span> projects, workspaces, chats,
          tool executions, Direct runs, token usage — in{" "}
          <code className={PATH_CHIP_CLASS}>
            ~/Library/Application Support/octopush/octopush.db
          </code>
          . Runs and custom pipelines leave it only if you turn on sync.
        </li>
        <li>
          <span className={LEAD_IN_CLASS}>API keys:</span> stored in{" "}
          <code className={PATH_CHIP_CLASS}>~/.octopush/settings.json</code>. MCP servers you add in
          Settings: <code className={PATH_CHIP_CLASS}>~/.claude/mcp.json</code>. A Token sign-in, an
          OAuth client secret, the values you mark Keep in Keychain and your Epiku token go to the macOS
          Keychain, and mcp-remote keeps a browser sign-in in{" "}
          <code className={PATH_CHIP_CLASS}>~/.mcp-auth</code>. A project's own{" "}
          <code className={PATH_CHIP_CLASS}>.claude/mcp.json</code> stays as written; its servers start only
          once you approve them, and the approvals stay in octopush.db. Your account
          session lives in the macOS Keychain too.
        </li>
        <li>
          <span className={LEAD_IN_CLASS}>Outbound traffic, only to:</span>
          <ul className={OUTBOUND_LIST_CLASS} data-testid="privacy-outbound">
            {OUTBOUND.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </li>
        <li>
          <span className={LEAD_IN_CLASS}>No analytics, no telemetry.</span>
        </li>
        <li data-testid="privacy-agent-cli">
          <span className={LEAD_IN_CLASS}>{AGENT_CLI_NOTE.slice(0, AGENT_CLI_LEAD_IN.length)}</span>
          {AGENT_CLI_NOTE.slice(AGENT_CLI_LEAD_IN.length)}
        </li>
      </ul>

      <div className="mt-8 space-y-2">
        <QuietClaudeCodeRow />
        <p
          className="text-[12px] leading-[1.55] text-octo-sage"
          data-testid="privacy-quiet-off-note"
        >
          {QUIET_OFF_NOTE}
        </p>
      </div>
    </>
  );
}

/** `quietClaudeCode` — **off unless saved as `true`** (#703). Read-modify-
 *  write on `settings.json` so the other fields aren't clobbered; a failed
 *  save puts the switch back, so it never shows a state that isn't stored. */
function QuietClaudeCodeRow() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    ipc
      .getSettings()
      .then((s) => {
        if (live) setEnabled(s.quietClaudeCode === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function persist(on: boolean) {
    setEnabled(on);
    setBusy(true);
    try {
      const s = await ipc.getSettings();
      await ipc.saveSettings({ ...s, quietClaudeCode: on });
    } catch {
      setEnabled(!on);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-tour="settings-quiet-claude-code">
      <ToggleRow
        label={QUIET_LABEL}
        description={
          <>
            {QUIET_HELP_BEFORE}
            <code className={PATH_CHIP_CLASS}>{QUIET_ENV}</code>
            {QUIET_HELP_AFTER}
          </>
        }
        checked={enabled}
        onChange={(on) => void persist(on)}
        busy={busy}
        testId="quiet-claude-code-switch"
      />
    </div>
  );
}
