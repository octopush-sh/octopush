// Settings → Integrations — external services Octopush connects to: the issue
// tracker (master-detail, Jira today), the bundled Octopush MCP server for
// coding agents, and the stdio MCP servers whose tools appear in chat.
import { useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { McpStatus } from "../../lib/ipc";
import { pushToast } from "../Toasts";
import { PaneHeader, SectionLabel } from "./shared";
import { IssueTrackingSection } from "./IssueTrackingSection";
import { McpServersSection } from "./McpServersSection";

export function IntegrationsPane({ onConfigSaved }: { onConfigSaved?: () => void }) {
  return (
    <>
      <PaneHeader
        eyebrow="Integrations"
        title="Connect your tools."
        subtitle="Wire up external services so Octopush can surface context right where you work."
      />

      {/* ── Issue tracking — master-detail over trackers ── */}
      <IssueTrackingSection onConfigSaved={onConfigSaved} />

      {/* ── Coding Agents — Octopush MCP server ── */}
      <ClaudeCodeCard />

      {/* ── MCP servers Octopush connects to (chat tools) ── */}
      <McpServersSection />
    </>
  );
}

/**
 * Integrations card for the bundled Octopush MCP server. One click registers it
 * with Claude Code (`claude mcp add`), with a copyable manual command as the
 * fallback when the CLI can't be located from the app's environment.
 */
function ClaudeCodeCard() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    ipc.mcpConnectionStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, []);

  async function connect() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await ipc.connectClaudeCode();
      setMessage(result.message);
      setStatus((s) => (s ? { ...s, registered: result.registered, binaryPath: result.binaryPath } : s));
      pushToast({
        level: result.ok ? "success" : "error",
        title: result.ok ? "Claude Code connected" : "Couldn't connect automatically",
        body: result.message,
      });
    } catch (e) {
      setMessage(String(e));
      pushToast({ level: "error", title: "Connect failed", body: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function copyCommand() {
    if (!status) return;
    void navigator.clipboard.writeText(status.manualCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const registered = status?.registered ?? false;

  return (
    <div className="mt-8 max-w-[640px]">
      <SectionLabel>Coding Agents</SectionLabel>
      <p className="mb-4 text-[12px] leading-[1.55] text-octo-mute">
        The Octopush MCP server lets agents in your terminal author DIRECT-mode pipelines and
        read your projects, workspaces, and runs — over the same store this app uses.
      </p>

      <div
        className="rounded-lg px-4 py-4"
        style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-serif text-[15px] leading-tight text-octo-ivory">Claude Code</div>
            <div className="mt-0.5 text-[12px] text-octo-sage">
              Register the bundled <span className="font-mono text-octo-mute">octopush-mcp</span> server.
            </div>
          </div>
          {registered ? (
            <span className="octo-pop-in font-mono text-[10px] uppercase tracking-[0.2em] text-octo-verdigris">
              ✓ Connected
            </span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute">
              Not connected
            </span>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy}
            className="min-w-[200px] rounded-md px-4 py-2 text-center font-serif text-[13px] text-octo-brass transition-colors disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {busy ? "Connecting…" : registered ? "Reconnect to Claude Code" : "Connect to Claude Code"}
          </button>
        </div>

        {message && (
          <p className="octo-pop-in mt-3 text-[12px] leading-[1.55] text-octo-sage">{message}</p>
        )}

        {/* Manual fallback — always available for non-Claude clients or a missing CLI. */}
        <div className="mt-4">
          <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
            Or register manually
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={status?.manualCommand ?? "claude mcp add octopush -s user -- /path/to/octopush-mcp"}
              readOnly
              className="flex-1 rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none"
            />
            <button
              type="button"
              onClick={copyCommand}
              className="min-w-[80px] rounded-md px-3 py-2 text-center font-serif text-[12px] text-octo-brass transition-colors"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
          {status && !status.claudeFound && (
            <p className="mt-2 text-[11px] text-octo-mute">
              Claude Code CLI not detected — run the command above in your terminal.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
