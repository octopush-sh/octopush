import { useEffect } from "react";
import { Server } from "lucide-react";
import { chipTone } from "../CompanionMcpScope";
import { runsOnClaudeCode } from "../../lib/claudeCli";
import type { McpServerStatus } from "../../lib/types";
import { useMcpScopeStore } from "../../stores/mcpScopeStore";
import type { AgentSubstrate } from "../../lib/ipc";

// Stable empties so the selector never hands React a fresh array per render.
const NO_STATUS: McpServerStatus[] = [];
const NONE: string[] = [];

const FIELD_TITLE =
  "The MCP servers this stage may use, from Settings › Integrations and this project's .claude/mcp.json. " +
  "Off for every stage until you turn one on: crews run unattended. A read-only stage gets only the tools a server marks read-only. " +
  "Not in detached runs or Routines yet.";

/** Why the field is unavailable on a CLI stage: the CLI brings its own
 *  servers. Pure so the copy is tested. */
export function mcpUnavailableTitle(model: string): string {
  return runsOnClaudeCode(model)
    ? "Claude Code stages use Claude Code's own MCP servers (~/.claude.json and the project's .mcp.json) for now."
    : "Codex stages use Codex's own MCP servers (~/.codex/config.toml) for now.";
}

/** A chip's tooltip: the server, what Talk's registry knows about it (null
 *  when it isn't configured here), and what a click does. Pure. */
export function stageMcpChipTitle(name: string, status: McpServerStatus | null, on: boolean): string {
  const state = !status
    ? "not configured on this Mac or in this project"
    : status.state === "connected"
      ? status.tools == null
        ? "connected"
        : `connected · ${status.tools} ${status.tools === 1 ? "tool" : "tools"}`
      : status.state === "failed"
        ? `failed${status.reason ? `: ${status.reason}` : ""}`
        : "not started yet · it starts when the stage runs";
  return `${name} · ${state} · ${on ? "click to take it off this stage" : "click to let this stage use it"}`;
}

/** The chips to show: every configured server, then any the stage chose that
 *  isn't configured here (so it can be taken off). Pure. */
export function stageMcpChips(status: McpServerStatus[], chosen: string[]): { name: string; status: McpServerStatus | null }[] {
  const known = status.map((s) => ({ name: s.name, status: s as McpServerStatus | null }));
  const extra = chosen.filter((n) => !status.some((s) => s.name === n)).sort();
  return [...known, ...extra.map((name) => ({ name, status: null }))];
}

/** The Stage inspector's "MCP servers" field (#1134): one toggle chip per
 *  server, off by default. API stages only for now; on a CLI stage the chips
 *  are disabled and the field says why. */
export function StageMcpServers({
  workspacePath,
  substrate,
  model,
  chosen,
  onChange,
}: {
  workspacePath?: string;
  substrate: AgentSubstrate;
  model: string;
  chosen: string[] | undefined;
  onChange: (next: string[]) => void;
}) {
  const status = useMcpScopeStore((s) => (workspacePath ? s.statusByPath[workspacePath] : undefined) ?? NO_STATUS);
  useEffect(() => {
    if (workspacePath) void useMcpScopeStore.getState().loadStatus(workspacePath);
  }, [workspacePath]);
  const isCli = substrate === "cli";
  const on = chosen ?? NONE;
  const chips = stageMcpChips(status, on);
  const toggle = (name: string) =>
    onChange(on.includes(name) ? on.filter((n) => n !== name) : [...on, name].sort());

  return (
    <div className="flex flex-col gap-1.5" data-tour="builder-stage-mcp">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute" title={FIELD_TITLE}>
        MCP servers
      </span>
      {chips.length === 0 ? (
        <span className="font-mono text-[9px] text-octo-mute">
          No MCP servers in Settings › Integrations or this project's .claude/mcp.json.
        </span>
      ) : (
        // A disabled button may fire no mouse events in WebKit, so the reason
        // rides this wrapper, and the pointer passes through to it.
        <div
          title={isCli ? mcpUnavailableTitle(model) : undefined}
          className={isCli ? "cursor-not-allowed *:pointer-events-none" : undefined}
        >
          <div className="flex flex-wrap gap-1.5" aria-disabled={isCli}>
            {chips.map(({ name, status: s }) => {
              const active = on.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  role="switch"
                  aria-checked={active}
                  disabled={isCli}
                  title={stageMcpChipTitle(name, s, active)}
                  onClick={() => toggle(name)}
                  className={`octo-fade-in flex items-center gap-1 rounded-sm border px-2 py-1 font-mono text-[10px] transition-colors duration-[150ms] disabled:opacity-40 ${
                    active
                      ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)] text-octo-brass"
                      : "border-octo-border-strong text-octo-mute hover:text-octo-sage"
                  }`}
                >
                  <Server size={10} aria-hidden className={`shrink-0 ${s ? chipTone(s.state, !active) : "text-octo-mute"}`} />
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {isCli && chips.length > 0 && (
        <span className="font-mono text-[9px] text-octo-mute">The CLI agent brings its own MCP servers.</span>
      )}
    </div>
  );
}
