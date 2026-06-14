import { useState, type CSSProperties } from "react";
import { ipc } from "../lib/ipc";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import type { ToolExecution } from "../stores/chatStore";

interface Props {
  tool: ToolExecution;
  workspacePath?: string;
  /** Called when the user wants to open the written file in the in-app
   *  editor (Review → Editor view). When omitted, the button is hidden. */
  onOpenInEditor?: (relativePath: string) => void;
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

export function ToolCallCard({ tool, workspacePath, onOpenInEditor }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { copied, copy } = useCopyFeedback();

  const label = toolLabel(tool.toolName);
  const summary = summarizeTool(tool.toolName, tool.toolInput);
  const filePath = getFilePath(tool);
  const isWebFile = filePath ? /\.(html?|htm)$/i.test(filePath) : false;

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
          <pre
            style={{
              maxHeight: 256,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              borderRadius: 4,
              background: ONYX,
              padding: "10px 12px",
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
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
