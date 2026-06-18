// Settings → Integrations — external services Octopus connects to: the Jira
// issue tracker (read-only), per-project Jira key mappings, and the bundled
// Octopush MCP server for coding agents.
import { useEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { McpStatus } from "../../lib/ipc";
import type { ProjectInfo } from "../../lib/types";
import { pushToast } from "../Toasts";
import { PaneHeader, SectionLabel } from "./shared";
import { McpServersSection } from "./McpServersSection";

// Sentinel shown in the API-token field when a saved token is loaded; if the
// user submits without editing the field we substitute the original token so
// the bullets aren't persisted as the actual credential.
const MASKED_TOKEN_PLACEHOLDER = "••••••••••••••••";

export function IntegrationsPane({ onConfigSaved }: { onConfigSaved?: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const originalTokenRef = useRef("");

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [mapDrafts, setMapDrafts] = useState<Record<string, string>>({});
  const [mapSaving, setMapSaving] = useState<Record<string, boolean>>({});
  const [mapSaved, setMapSaved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    ipc.getIssueTrackerConfig()
      .then((cfg) => {
        if (cfg) {
          setBaseUrl(cfg.baseUrl ?? "");
          setEmail(cfg.email ?? "");
          if (cfg.apiToken) {
            originalTokenRef.current = cfg.apiToken;
            setApiToken(MASKED_TOKEN_PLACEHOLDER);
          }
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    ipc.listRecentProjects()
      .then((rows) => {
        setProjects(rows);
        const drafts: Record<string, string> = {};
        for (const p of rows) drafts[p.id] = p.jiraProjectKey ?? "";
        setMapDrafts(drafts);
      })
      .catch(() => { /* quiet — pane still renders the credentials section */ });
  }, []);

  async function saveMapping(projectId: string) {
    const value = (mapDrafts[projectId] ?? "").trim();
    setMapSaving((s) => ({ ...s, [projectId]: true }));
    try {
      await ipc.updateProjectJiraKey(projectId, value === "" ? null : value);
      setMapSaved((s) => ({ ...s, [projectId]: true }));
      setTimeout(() => setMapSaved((s) => ({ ...s, [projectId]: false })), 2000);
    } catch (e) {
      pushToast({ level: "error", title: "Save mapping failed", body: String(e) });
    } finally {
      setMapSaving((s) => ({ ...s, [projectId]: false }));
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const tokenToSave =
        apiToken === MASKED_TOKEN_PLACEHOLDER ? originalTokenRef.current : apiToken;
      await ipc.saveIssueTrackerConfig({ baseUrl, email, apiToken: tokenToSave });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onConfigSaved?.();
      // Fire-and-forget: refresh the backlog immediately so the RUN Companion
      // populates without waiting for a re-mount.
      const { useIssuesStore } = await import("../../stores/issuesStore");
      useIssuesStore.getState().load();
    } catch (e) {
      pushToast({ level: "error", title: "Save failed", body: String(e) });
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;

  return (
    <>
      <PaneHeader
        eyebrow="Integrations"
        title="Connect your tools."
        subtitle="Wire up external services so Octopus can surface context right where you work."
      />

      {/* ── Issue Tracker section ── */}
      <div className="max-w-[640px]">
        <SectionLabel>Issue Tracker</SectionLabel>
        <p className="mb-4 text-[12px] leading-[1.55] text-octo-mute">
          Jira Cloud — read-only access for the backlog and ticket chip.
        </p>

        <div className="space-y-3">
          <Field label="Base URL">
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-company.atlassian.net"
              className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
            />
          </Field>

          <Field label="Email">
            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@your-company.com"
              className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
            />
          </Field>

          <Field label="API Token">
            <div className="relative">
              <input
                type={showToken ? "text" : "password"}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="API token"
                className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 pr-10 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
              >
                {showToken ? "Hide" : "Show"}
              </button>
            </div>
          </Field>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="min-w-[150px] rounded-md px-4 py-2 text-center font-serif text-[13px] text-octo-brass transition-colors disabled:opacity-50"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              {saved ? "✓ Saved" : saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Project Mappings sub-section ── */}
      <div className="mt-8 max-w-[640px]">
        <SectionLabel>Project Mappings</SectionLabel>
        <p className="mb-4 text-[12px] leading-[1.55] text-octo-mute">
          Link each Octopush Project to its Jira project key. Empty = inferred from the workspace branch.
        </p>
        <div className="space-y-3">
          {projects.map((p) => (
            <div key={p.id} className="flex items-center gap-3">
              <div className="w-[180px] truncate text-[13px] text-octo-ivory" title={p.name}>{p.name}</div>
              <input
                type="text"
                value={mapDrafts[p.id] ?? ""}
                onChange={(e) => setMapDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                placeholder="Jira project key"
                className="flex-1 rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
              <button
                type="button"
                onClick={() => void saveMapping(p.id)}
                disabled={mapSaving[p.id]}
                aria-label="Save mapping"
                className="min-w-[120px] rounded-md px-3 py-2 text-center font-serif text-[12px] text-octo-brass transition-colors disabled:opacity-50"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {mapSaved[p.id] ? "✓ Saved" : mapSaving[p.id] ? "Saving…" : "Save mapping"}
              </button>
            </div>
          ))}
          {projects.length === 0 && (
            <p className="text-[12px] text-octo-mute">No projects opened yet.</p>
          )}
        </div>
      </div>

      {/* ── Coding Agents — Octopush MCP server ── */}
      <ClaudeCodeCard />

      {/* ── MCP servers Octopush connects to (chat tools) ── */}
      <McpServersSection />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">{label}</div>
      {children}
    </div>
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
