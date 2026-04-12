import { useState } from "react";
import { ipc } from "../lib/ipc";
import type { ToolExecution } from "../stores/chatStore";

interface Props {
  tool: ToolExecution;
  workspacePath?: string;
}

const TOOL_ICONS: Record<string, string> = {
  run_command: ">_",
  read_file: "[]",
  write_file: "[+]",
  list_files: "dir",
};

const TOOL_LABELS: Record<string, string> = {
  run_command: "Ran command",
  read_file: "Read file",
  write_file: "Wrote file",
  list_files: "Listed files",
};

const TOOL_COLORS: Record<string, string> = {
  run_command: "#fbbf24",
  read_file: "#60a5fa",
  write_file: "#34d399",
  list_files: "#a1a1aa",
};

/**
 * Tool call card using INLINE STYLES exclusively.
 * Tailwind classes were being affected by ReactMarkdown's CSS output
 * in sibling elements, causing cards to become invisible.
 */
export function ToolCallCard({ tool, workspacePath }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const label = TOOL_LABELS[tool.toolName] ?? tool.toolName;
  const icon = TOOL_ICONS[tool.toolName] ?? "?";
  const color = TOOL_COLORS[tool.toolName] ?? "#a1a1aa";
  const summary = buildSummary(tool);
  const filePath = getFilePath(tool);
  const isWebFile = filePath ? /\.(html?|htm)$/i.test(filePath) : false;

  function handleCopy() {
    navigator.clipboard.writeText(tool.result);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleOpen() {
    if (filePath && workspacePath) {
      ipc.openFileInSystem(`${workspacePath}/${filePath}`);
    }
  }

  return (
    <div
      style={{
        width: "100%",
        maxWidth: "85%",
        margin: "0 auto",
        borderRadius: 8,
        border: "1px solid rgba(255,255,255,0.08)",
        background: expanded ? "rgba(24,24,27,0.6)" : "rgba(24,24,27,0.3)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center" }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span
            style={{
              fontSize: 10,
              color: "#71717a",
              transition: "transform 150ms",
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              flexShrink: 0,
            }}
          >
            ▸
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              borderRadius: 4,
              background: `${color}15`,
              color: color,
              fontSize: 10,
              fontWeight: 600,
              flexShrink: 0,
              fontFamily: "monospace",
            }}
          >
            {icon}
          </span>
          <span style={{ fontSize: 11, color: "#a1a1aa", flexShrink: 0 }}>
            {label}
          </span>
          <span
            style={{
              fontSize: 12,
              fontFamily: "monospace",
              color: color,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {summary}
          </span>
        </button>

        {/* Action buttons for write_file */}
        {filePath && tool.toolName === "write_file" && (
          <div style={{ display: "flex", gap: 4, paddingRight: 12, flexShrink: 0 }}>
            {isWebFile && (
              <button
                onClick={handleOpen}
                style={{
                  fontSize: 10,
                  fontWeight: 500,
                  color: "#a78bfa",
                  background: "rgba(167,139,250,0.1)",
                  border: "none",
                  borderRadius: 4,
                  padding: "4px 8px",
                  cursor: "pointer",
                }}
              >
                Open
              </button>
            )}
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.06)",
            padding: "8px 14px 12px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
            <button
              onClick={handleCopy}
              style={{
                fontSize: 10,
                color: "#71717a",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "2px 6px",
                borderRadius: 4,
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre
            style={{
              maxHeight: 256,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              borderRadius: 6,
              background: "rgba(9,9,11,0.8)",
              padding: "8px 12px",
              fontFamily: "monospace",
              fontSize: 11,
              lineHeight: 1.6,
              color: "#a1a1aa",
              margin: 0,
            }}
          >
            {tool.result}
          </pre>
        </div>
      )}
    </div>
  );
}

function buildSummary(tool: ToolExecution): string {
  switch (tool.toolName) {
    case "run_command": {
      const cmd = String(tool.toolInput?.command ?? "");
      return `$ ${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}`;
    }
    case "read_file":
    case "write_file": {
      const path = String(tool.toolInput?.path ?? "");
      return path;
    }
    case "list_files":
      return String(tool.toolInput?.path ?? ".");
    default:
      return tool.toolName;
  }
}

function getFilePath(tool: ToolExecution): string | null {
  if (tool.toolName === "write_file" || tool.toolName === "read_file") {
    return String(tool.toolInput?.path ?? "") || null;
  }
  return null;
}
