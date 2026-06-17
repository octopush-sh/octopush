import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, Check, AlertTriangle } from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { McpServerConfig } from "../../lib/types";
import { pushToast } from "../Toasts";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; tools: number }
  | { kind: "error"; message: string };

const inputClass =
  "w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass";
const labelClass =
  "mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute";

/** Parse a "KEY=value" textarea into an env map (blank/##-comment lines skipped). */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

/**
 * Settings UI for the stdio MCP servers Octopush connects to (their tools show
 * up in the TALK chat). Reads/writes `~/.claude/mcp.json` and offers a per-row
 * "Test connection" that spawns the server and lists its tools.
 *
 * Remote servers (e.g. Atlassian) need a stdio bridge — use `npx mcp-remote
 * <url>` as the command. Project-level `.claude/mcp.json` in a repo is also
 * honored at runtime but is edited in the repo, not here.
 */
export function McpServersSection() {
  const [servers, setServers] = useState<Record<string, McpServerConfig>>({});
  const [loaded, setLoaded] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [adding, setAdding] = useState(false);

  // Draft for a new server.
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    // Defensive: tolerate environments where the ipc method is absent.
    Promise.resolve(ipc.getMcpConfig?.())
      .then((cfg) => setServers(cfg ?? {}))
      .catch((e) => pushToast({ level: "error", title: "Couldn't load MCP config", body: String(e) }))
      .finally(() => setLoaded(true));
  }, []);

  async function persist(next: Record<string, McpServerConfig>) {
    setServers(next);
    try {
      await ipc.saveMcpConfig(next);
    } catch (e) {
      pushToast({ level: "error", title: "Save failed", body: String(e) });
    }
  }

  function resetDraft() {
    setName("");
    setCommand("");
    setArgsText("");
    setEnvText("");
    setAdding(false);
  }

  async function addServer() {
    const key = name.trim();
    if (!key || !command.trim()) return;
    const config: McpServerConfig = {
      command: command.trim(),
      args: argsText.split("\n").map((s) => s.trim()).filter(Boolean),
      env: parseEnv(envText),
    };
    await persist({ ...servers, [key]: config });
    resetDraft();
  }

  async function removeServer(key: string) {
    const next = { ...servers };
    delete next[key];
    await persist(next);
  }

  async function testServer(key: string) {
    const config = servers[key];
    if (!config) return;
    setTests((s) => ({ ...s, [key]: { kind: "testing" } }));
    try {
      const tools = await ipc.testMcpServer(key, config);
      setTests((s) => ({ ...s, [key]: { kind: "ok", tools: tools.length } }));
    } catch (e) {
      setTests((s) => ({ ...s, [key]: { kind: "error", message: String(e) } }));
    }
  }

  if (!loaded) return null;

  const entries = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="mt-10 max-w-[640px]">
      <SectionLabel>MCP Servers</SectionLabel>
      <p className="mb-4 text-[12px] leading-[1.55] text-octo-mute">
        Local (stdio) Model Context Protocol servers whose tools become available
        to Talk. For a remote/OAuth server (e.g. Atlassian) use a bridge as the
        command — <span className="font-mono text-octo-sage">npx mcp-remote &lt;url&gt;</span>.
      </p>

      <div className="space-y-2">
        {entries.length === 0 && (
          <p className="text-[12px] text-octo-mute">No MCP servers configured.</p>
        )}
        {entries.map(([key, cfg]) => {
          const test = tests[key] ?? { kind: "idle" };
          return (
            <div key={key} className="rounded-md border border-octo-hairline bg-octo-panel px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[12px] text-octo-brass">{key}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-mute">
                  {cfg.command} {cfg.args.join(" ")}
                </span>
                <button
                  type="button"
                  onClick={() => testServer(key)}
                  disabled={test.kind === "testing"}
                  className="flex items-center gap-1.5 rounded border border-octo-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:border-[var(--brass-dim)] hover:text-octo-brass disabled:opacity-40"
                >
                  {test.kind === "testing" ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : null}
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => removeServer(key)}
                  aria-label={`Remove ${key}`}
                  title="Remove server"
                  className="flex items-center justify-center rounded p-1 text-octo-mute transition-colors hover:text-octo-rouge"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {test.kind === "ok" && (
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-octo-verdigris">
                  <Check size={12} /> Connected · {test.tools} tool{test.tools === 1 ? "" : "s"}
                </div>
              )}
              {test.kind === "error" && (
                <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-octo-rouge">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span className="break-all">{test.message}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {adding ? (
        <div className="mt-3 space-y-3 rounded-md border border-octo-hairline bg-octo-panel p-3">
          <div>
            <div className={labelClass}>Name</div>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
          </div>
          <div>
            <div className={labelClass}>Command</div>
            <input className={inputClass} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </div>
          <div>
            <div className={labelClass}>Args (one per line)</div>
            <textarea
              className={`${inputClass} h-20 resize-none`}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-github"}
            />
          </div>
          <div>
            <div className={labelClass}>Env (KEY=value, one per line)</div>
            <textarea
              className={`${inputClass} h-16 resize-none`}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="GITHUB_TOKEN=ghp_…"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addServer}
              disabled={!name.trim() || !command.trim() || !!servers[name.trim()]}
              title={servers[name.trim()] ? "A server with this name already exists" : undefined}
              className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass transition-colors disabled:opacity-40"
            >
              Add server
            </button>
            {!!servers[name.trim()] && (
              <span className="font-mono text-[10px] text-octo-rouge">name already exists</span>
            )}
            <button
              type="button"
              onClick={resetDraft}
              className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:text-octo-ivory"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:border-[var(--brass-dim)] hover:text-octo-brass"
        >
          <Plus size={12} /> Add MCP server
        </button>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
      {children}
    </h2>
  );
}
