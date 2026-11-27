import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { chipTone } from "../CompanionMcpScope";
import { runsOnClaudeCode } from "../../lib/claudeCli";
import type { McpServerStatus } from "../../lib/types";
import { useMcpScopeStore } from "../../stores/mcpScopeStore";
import { ipc, type AgentSubstrate } from "../../lib/ipc";

// Stable empty so the selector never hands React a fresh array per render.
const NONE: string[] = [];

const EASE = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

const FIELD_TITLE =
  "The MCP servers this stage may use, from Settings › Integrations and this project's .claude/mcp.json. " +
  "Off for every stage until you turn one on: crews run unattended. A read-only stage gets only the tools a server marks read-only. " +
  "Not in detached runs or Routines yet.";

/** What a chip knows about its server: the registry's status, `null` when
 *  the server isn't configured here, `"unknown"` when the list couldn't be
 *  read (no workspace, or a failed read). */
export type StageMcpChipStatus = McpServerStatus | null | "unknown";

/** Why the field is unavailable on a CLI stage: the CLI brings its own
 *  servers. Pure so the copy is tested. */
export function mcpUnavailableTitle(model: string): string {
  return runsOnClaudeCode(model)
    ? "Claude Code stages use Claude Code's own MCP servers (~/.claude.json and the project's .mcp.json) for now."
    : "Codex stages use Codex's own MCP servers (~/.codex/config.toml) for now.";
}

/** A chip's tooltip: the server, what Talk's registry knows about it, and
 *  what a click does. Pure. */
export function stageMcpChipTitle(name: string, status: StageMcpChipStatus, on: boolean): string {
  const state =
    status === "unknown"
      ? "status unknown"
      : !status
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
 *  isn't configured here (so it can be taken off). With no reading
 *  (`status` null), only the chosen servers, of unknown status. Pure. */
export function stageMcpChips(
  status: McpServerStatus[] | null,
  chosen: string[],
): { name: string; status: StageMcpChipStatus }[] {
  if (!status) return [...chosen].sort().map((name) => ({ name, status: "unknown" as const }));
  const known = status.map((s) => ({ name: s.name, status: s as StageMcpChipStatus }));
  const extra = chosen.filter((n) => !status.some((s) => s.name === n)).sort();
  return [...known, ...extra.map((name) => ({ name, status: null }))];
}

/** The field's one line under the chips, if any: what the list's reading
 *  is, never "none configured" unless a read said so. Pure. */
export function stageMcpNote(
  workspacePath: string | undefined,
  status: McpServerStatus[] | undefined,
  failed: boolean,
): string | null {
  if (!workspacePath) return "Open a workspace to choose its MCP servers.";
  if (status) return status.length === 0 ? "No MCP servers in Settings › Integrations or this project's .claude/mcp.json." : null;
  return failed ? "Couldn't read the MCP servers configured here." : "Reading the MCP servers…";
}

/** The Stage inspector's "MCP servers" field (#1134): one toggle chip per
 *  server, off by default. API stages only for now; on a CLI stage the chips
 *  are disabled and the field says why. The list re-reads on a workspace
 *  change and on `mcp://config-changed` / `mcp://status-changed`. */
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
  const status = useMcpScopeStore((s) => (workspacePath ? s.statusByPath[workspacePath] : undefined));
  // The path whose last read failed; a reading already held still shows.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void ipc
      .onMcpChanged(() => setTick((t) => t + 1))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!workspacePath) return;
    let live = true;
    void useMcpScopeStore
      .getState()
      .loadStatus(workspacePath)
      .then((ok) => {
        if (live) setFailedPath(ok ? null : workspacePath);
      });
    return () => {
      live = false;
    };
  }, [workspacePath, tick]);

  const isCli = substrate === "cli";
  const on = chosen ?? NONE;
  const failed = !!workspacePath && failedPath === workspacePath;
  const loading = !!workspacePath && !status && !failed;
  const chips = loading ? [] : stageMcpChips(status ?? null, on);
  const note = stageMcpNote(workspacePath, status, failed);
  const toggle = (name: string) =>
    onChange(on.includes(name) ? on.filter((n) => n !== name) : [...on, name].sort());

  return (
    <div className="flex flex-col gap-1.5" data-tour="builder-stage-mcp">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute" title={FIELD_TITLE}>
        MCP servers
      </span>
      {chips.length > 0 && (
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
                  className={`octo-fade-in flex items-center gap-1 rounded-sm border px-2 py-1 font-mono text-[10px] ${EASE} disabled:opacity-40 ${
                    active
                      ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)] text-octo-brass"
                      : "border-octo-border-strong text-octo-mute hover:text-octo-sage"
                  }`}
                >
                  {/* The icon carries the server's state whether the chip is on or off. */}
                  <Server
                    size={10}
                    aria-hidden
                    data-testid="stage-mcp-icon"
                    className={`shrink-0 ${EASE} ${s && s !== "unknown" ? chipTone(s.state, false) : "text-octo-mute"}`}
                  />
                  {name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {note && <span className="octo-fade-in font-mono text-[9px] text-octo-mute">{note}</span>}
      {isCli && chips.length > 0 && (
        <span className="font-mono text-[9px] text-octo-mute">The CLI agent brings its own MCP servers.</span>
      )}
    </div>
  );
}
