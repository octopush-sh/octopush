import { useState, useRef, useLayoutEffect, type CSSProperties } from "react";
import { ipc } from "../lib/ipc";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import type { ToolExecution } from "../stores/chatStore";

interface Props {
  tool: ToolExecution;
  workspacePath?: string;
  /** Called when the user wants to open the written file in the in-app
   *  editor (Review → Editor view). When omitted, the button is hidden. */
  onOpenInEditor?: (relativePath: string) => void;
  /** Called to re-run a `run_command` tool's command in the RUN-mode terminal.
   *  When omitted, the button is hidden. (Cross-mode action, P9.) */
  onRunInTerminal?: (command: string) => void;
}

// Tool name → uppercase mono label. Falls back to the raw tool name.
export const TOOL_LABELS: Record<string, string> = {
  run_command: "RUN",
  read_file: "READ",
  write_file: "WRITE",
  list_files: "LIST",
};

/** The card header label for a tool name (e.g. `write_file` → `WRITE`,
 *  `mcp__github__create_issue` → `MCP`). */
export function toolLabel(toolName: string): string {
  if (toolName.startsWith("mcp__")) return "MCP";
  return TOOL_LABELS[toolName] ?? toolName.toUpperCase();
}

/** One-line summary of a tool call from its input (path or command). Shared by
 *  the resolved ToolCallCard and the live "running" card. */
export function summarizeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): string {
  // MCP tools render as `server · tool` so the namespaced name is readable.
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice(5);
    const sep = rest.indexOf("__");
    return sep >= 0 ? `${rest.slice(0, sep)} · ${rest.slice(sep + 2)}` : rest;
  }
  switch (toolName) {
    case "run_command": {
      const cmd = String(toolInput?.command ?? "");
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "write_file":
    case "read_file":
      return String(toolInput?.path ?? "");
    case "list_files":
      return String(toolInput?.path ?? ".");
    default:
      return toolName;
  }
}

// Onyx & Brass design tokens. Defined inline because this component renders
// inside react-markdown siblings — the previous fix cycle (commit d9c1517)
// proved Tailwind cascade can leak in this context. Inline styles are
// deliberate and load-bearing.
const BRASS = "#d4a574";
const BRASS_DIM = "rgba(212, 165, 116, 0.4)";
const BRASS_GHOST = "rgba(212, 165, 116, 0.08)";
const IVORY = "#f4ecdb";
const SAGE = "#95897a";
const MUTE = "#6d6354";
const ONYX = "#0c0a08";
const HAIRLINE = "#2a2419";
// Same load-bearing-inline rationale as the colors above: the mono stack must be
// inline here (react-markdown cascade leak), but it lives in ONE const so the
// new output controls don't scatter another copy of the literal.
const MONO = "'JetBrains Mono', 'SF Mono', monospace";

// Tool card has a FULL hairline-brass border (not just left), a slightly
// more opaque brass-tinted background, and a subtle inset highlight so it
// reads as a distinct surface against the onyx canvas. The previous
// "border-left only + 8% bg" version was too subtle — cards were in the
// DOM but looked like empty space (see ChatView.test.tsx "survives the
// done event" — that test now also asserts visible-pixel presence).
const cardStyle: CSSProperties = {
  display: "block",
  width: "100%",
  maxWidth: "100%",
  margin: "10px 0",
  borderRadius: 8,
  border: `1px solid ${BRASS_DIM}`,
  background: "rgba(212, 165, 116, 0.06)",
  boxShadow: "inset 0 1px 0 rgba(212, 165, 116, 0.08)",
  fontSize: 12,
  fontFamily: "-apple-system, 'Helvetica Neue', sans-serif",
  color: SAGE,
  lineHeight: "1.4",
  boxSizing: "border-box" as const,
  overflow: "hidden",
  minHeight: 36,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  padding: "8px 12px",
  gap: 10,
  cursor: "pointer",
  background: "transparent",
  border: "none",
  color: "inherit",
  fontSize: "inherit",
  fontFamily: "inherit",
  lineHeight: "inherit",
  textAlign: "left" as const,
  boxSizing: "border-box" as const,
};

export function ToolCallCard({ tool, workspacePath, onOpenInEditor, onRunInTerminal }: Props) {
  const [expanded, setExpanded] = useState(false);
  // Result output is capped (COLLAPSED_OUTPUT_PX) until the user opts to see it
  // all — so a long `npm install` log doesn't silently clip with no signal.
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [outputOverflows, setOutputOverflows] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopyFeedback();

  const label = toolLabel(tool.toolName);
  const summary = summarizeTool(tool.toolName, tool.toolInput);
  const filePath = getFilePath(tool);
  const isWebFile = filePath ? /\.(html?|htm)$/i.test(filePath) : false;
  const command =
    tool.toolName === "run_command" ? String(tool.toolInput?.command ?? "") : "";
  // Where a `$`-direct command ran, relative to the workspace root (only set
  // when not the root) — surfaces the persistent shell's cwd per command.
  const cwd =
    tool.toolName === "run_command" ? String(tool.toolInput?.cwd ?? "") : "";

  // Measure whether the (capped) output actually overflows, so the "Show full
  // output" affordance and bottom fade only appear when there's more to see.
  useLayoutEffect(() => {
    const el = outputRef.current;
    if (!el || outputExpanded) return;
    setOutputOverflows(el.scrollHeight > el.clientHeight + 4);
  }, [expanded, outputExpanded, tool.result]);

  return (
    <div className="chat-selectable" style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
          style={headerStyle}
        >
          <span
            style={{
              fontSize: 13,
              color: BRASS,
              fontFamily: "'Spectral', serif",
              
              flexShrink: 0,
            }}
            aria-hidden
          >
            §
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: BRASS,
              flexShrink: 0,
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontSize: 11,
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              color: SAGE,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: 1,
              marginLeft: 4,
            }}
          >
            {summary}
          </span>
          {cwd && (
            <span
              title={`ran in ${cwd}`}
              style={{
                fontSize: 10,
                color: MUTE,
                fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                flexShrink: 0,
                marginLeft: 6,
                maxWidth: 160,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {cwd}
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              color: MUTE,
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 150ms",
              flexShrink: 0,
            }}
            aria-hidden
          >
            ▸
          </span>
        </div>

        {command && onRunInTerminal && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onRunInTerminal(command);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRunInTerminal(command);
              }
            }}
            title="Send to terminal (copies the command and switches to Run)"
            aria-label="Send to terminal"
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 11,
              color: BRASS,
              background: BRASS_GHOST,
              border: `1px solid ${BRASS_DIM}`,
              borderRadius: 4,
              padding: "3px 10px",
              cursor: "pointer",
              marginRight: 10,
              flexShrink: 0,
            }}
          >
            Send to terminal
          </div>
        )}

        {filePath && tool.toolName === "write_file" && onOpenInEditor && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onOpenInEditor(filePath);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenInEditor(filePath);
              }
            }}
            title="Open in editor"
            style={{
              fontFamily: "'Spectral', serif",
              
              fontSize: 11,
              color: BRASS,
              background: BRASS_GHOST,
              border: `1px solid ${BRASS_DIM}`,
              borderRadius: 4,
              padding: "3px 10px",
              cursor: "pointer",
              marginRight: 6,
              flexShrink: 0,
            }}
          >
            Open in editor
          </div>
        )}

        {filePath && tool.toolName === "write_file" && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (workspacePath) ipc.revealInFinder(`${workspacePath}/${filePath}`);
            }}
            onKeyDown={() => {}}
            title="Reveal in Finder"
            style={{
              fontSize: 12,
              color: MUTE,
              background: "transparent",
              border: "none",
              padding: "4px 8px",
              cursor: "pointer",
              marginRight: 4,
              flexShrink: 0,
              fontFamily: "system-ui, sans-serif",
              lineHeight: 1,
            }}
          >
            ⊙
          </div>
        )}

        {filePath && tool.toolName === "write_file" && isWebFile && (
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (workspacePath) ipc.openFileInSystem(`${workspacePath}/${filePath}`);
            }}
            onKeyDown={() => {}}
            style={{
              fontFamily: "'Spectral', serif",
              
              fontSize: 11,
              color: BRASS,
              background: BRASS_GHOST,
              border: `1px solid ${BRASS_DIM}`,
              borderRadius: 4,
              padding: "3px 10px",
              cursor: "pointer",
              marginRight: 10,
              flexShrink: 0,
            }}
          >
            Open
          </div>
        )}
      </div>

      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${HAIRLINE}`,
            padding: "8px 12px 12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => copy(tool.result)}
              onKeyDown={() => {}}
              style={{
                fontSize: 9,
                fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: copied ? "#8fc9a8" : MUTE,
                cursor: "pointer",
                padding: "2px 6px",
              }}
            >
              {copied ? "✓ COPIED" : "COPY"}
            </span>
          </div>
          <div style={{ position: "relative" }}>
            <pre
              ref={outputRef}
              style={{
                maxHeight: outputExpanded ? undefined : 256,
                overflow: outputExpanded ? "visible" : "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                borderRadius: 4,
                background: ONYX,
                padding: "10px 12px",
                fontFamily: MONO,
                fontSize: 11,
                lineHeight: 1.55,
                color: IVORY,
                margin: 0,
                boxSizing: "border-box" as const,
                border: `1px solid ${HAIRLINE}`,
              }}
            >
              {tool.result}
            </pre>
            {/* Fade hint that there's more output below the cap. */}
            {!outputExpanded && outputOverflows && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: 1,
                  right: 1,
                  bottom: 1,
                  height: 36,
                  pointerEvents: "none",
                  borderRadius: "0 0 4px 4px",
                  background: `linear-gradient(to bottom, rgba(12, 10, 8, 0), ${ONYX})`,
                }}
              />
            )}
          </div>
          {(outputOverflows || outputExpanded) && (
            <button
              type="button"
              onClick={() => setOutputExpanded((v) => !v)}
              style={{
                marginTop: 6,
                background: "transparent",
                border: "none",
                color: BRASS,
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 9,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                padding: "2px 0",
              }}
            >
              {outputExpanded ? "Show less" : "Show full output"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function getFilePath(tool: ToolExecution): string | null {
  if (tool.toolName === "write_file" || tool.toolName === "read_file") {
    return String(tool.toolInput?.path ?? "") || null;
  }
  return null;
}
