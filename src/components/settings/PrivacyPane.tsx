// Settings → Privacy — a read-only statement of what stays local and what
// leaves. Every line here must stay EXACTLY true: when a feature adds a new
// outbound destination, add it to OUTBOUND in the same change (the website
// quotes this copy).
import { PaneHeader } from "./shared";

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
          <span className="font-mono text-octo-brass">
            ~/Library/Application Support/octopush/octopush.db
          </span>
          . Runs and custom pipelines leave it only if you turn on sync.
        </li>
        <li>
          · <span className="font-serif text-octo-ivory">API keys:</span> stored in{" "}
          <span className="font-mono text-octo-brass">~/.octopush/settings.json</span>. Your
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
    </>
  );
}
