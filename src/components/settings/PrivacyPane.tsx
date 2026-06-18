// Settings → Privacy — a read-only statement of what stays local and what leaves.
import { PaneHeader } from "./shared";

export function PrivacyPane() {
  return (
    <>
      <PaneHeader
        eyebrow="Privacy"
        title="What stays, what leaves."
        subtitle="Octopus stores all chat history, API keys, and tokens locally. Provider API requests go directly to Anthropic/OpenAI from this machine."
      />

      <ul className="max-w-[640px] space-y-2 text-[13px] leading-[1.6] text-octo-sage">
        <li>· <span className="font-serif text-octo-ivory">Local-only data:</span> projects, workspaces, chat messages, tool executions, token usage. Stored in <span className="font-mono text-octo-brass">~/Library/Application Support/octopush/octopush.db</span>.</li>
        <li>· <span className="font-serif text-octo-ivory">API keys:</span> stored in <span className="font-mono text-octo-brass">~/.octopush/settings.json</span>.</li>
        <li>· <span className="font-serif text-octo-ivory">Outbound traffic:</span> only to providers you configure (Anthropic, OpenAI). No analytics, no telemetry.</li>
      </ul>
    </>
  );
}
