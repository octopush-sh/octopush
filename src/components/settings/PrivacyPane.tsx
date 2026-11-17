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
  "Integrations you connect — Jira, GitHub, a LiteLLM gateway, MCP servers — and your git remotes.",
  "Update checks — octopush.sh/update/latest.json and GitHub releases.",
  "LiteLLM's public pricing table on GitHub, when you refresh pricing.",
];

/** Third-party tools Octopush launches but doesn't control. */
export const AGENT_CLI_NOTE =
  "Agent CLIs Octopush launches for you (Claude Code, Codex) talk to their own services and follow their own telemetry policies.";

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

      <ul className="max-w-[640px] space-y-2 text-[13px] leading-[1.6] text-octo-sage">
        <li>
          · <span className="font-serif text-octo-ivory">Stored on this Mac:</span> projects,
          workspaces, chats, tool executions, Direct runs, token usage — in{" "}
          <code className={PATH_CHIP_CLASS}>
            ~/Library/Application Support/octopush/octopush.db
          </code>
          . Runs and custom pipelines leave it only if you turn on sync.
        </li>
        <li>
          · <span className="font-serif text-octo-ivory">API keys:</span> stored in{" "}
          <code className={PATH_CHIP_CLASS}>~/.octopush/settings.json</code>. Your
          account session lives in the macOS Keychain.
        </li>
        <li>
          · <span className="font-serif text-octo-ivory">Outbound traffic, only to:</span>
          <ul className="mt-1 space-y-1 pl-4" data-testid="privacy-outbound">
            {OUTBOUND.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </li>
        <li>
          · <span className="font-serif text-octo-ivory">No analytics, no telemetry.</span>
        </li>
        <li data-testid="privacy-agent-cli">· {AGENT_CLI_NOTE}</li>
      </ul>

      <div className="mt-8 max-w-[640px] space-y-2">
        <QuietClaudeCodeRow />
        <p
          className="px-4 text-[12px] leading-[1.55] text-octo-sage"
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
