import { useState, useRef, useLayoutEffect, type CSSProperties } from "react";
import { ipc } from "../lib/ipc";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { ChevronRight, ExternalLink, FilePen, FolderOpen, Terminal } from "lucide-react";
import { iconForTool } from "../lib/roleIcons";
import { tourId } from "../lib/tour/ids";
import { toolVerdict } from "../lib/toolVerdict";
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
  edit_file: "EDIT",
  list_files: "LIST",
  grep: "GREP",
  glob: "GLOB",
  Agent: "AGENT",
  Task: "AGENT",
  recall_tool_output: "RECALL",
  Skill: "SKILL",
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
    case "Agent":
    case "Task": {
      // A sub-agent card reads as `description · role`; the prompt itself is
      // the model's own words and never surfaces here.
      const desc = String(toolInput?.description ?? "Sub-agent");
      const role = toolInput?.subagentType ? String(toolInput.subagentType) : "";
      return role ? `${desc} · ${role}` : desc;
    }
    case "recall_tool_output":
      return `#${String(toolInput?.message_id ?? "")}`;
    case "Skill":
      // The model loaded a skill on its own (#1135).
      return `used skill ${String(toolInput?.name ?? toolInput?.skill ?? "")}`.trim();
    case "write_file":
    case "read_file":
    case "edit_file":
      return String(toolInput?.path ?? "");
    case "list_files":
      return String(toolInput?.path ?? ".");
    case "grep": {
      const pat = String(toolInput?.pattern ?? "");
      return pat.length > 60 ? pat.slice(0, 57) + "..." : pat;
    }
    case "glob":
      return String(toolInput?.pattern ?? "");
    default:
      return toolName;
  }
}

// Onyx & Brass design tokens. Still applied as INLINE STYLES, because this
// component renders inside react-markdown siblings and the previous fix cycle
// (commit d9c1517) proved Tailwind cascade can leak in this context — that
// rationale is unchanged and load-bearing.
//
// The values are `var(--…)` tokens, never literals: an inline style resolving
// a custom property is still an inline style, so it is equally immune to the
// cascade leak, and it follows the active theme. Colours and font stacks alike
// (the fonts are the `@theme` families in styles.css).
const BRASS = "var(--color-octo-brass)";
const IVORY = "var(--color-octo-ivory)";
const SAGE = "var(--color-octo-sage)";
const MUTE = "var(--color-octo-mute)";
const ROUGE = "var(--color-octo-rouge)";
const ONYX = "var(--color-octo-onyx)";
const HAIRLINE = "var(--color-octo-hairline)";
const MONO = "var(--font-mono)";
const SANS = "var(--font-sans)";

/** Keyboard activation for role="button" elements — Enter/Space fire the action,
 *  matching native button behavior (a11y: these were no-op onKeyDown before). */
function keyActivate(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// A resolved tool call is one quiet LEDGER ROW in the work block (the
// hairline ChatCanvas hangs a turn's narration and tool calls from): icon,
// label, summary, chevron, all mute and sage, no border, no fill. It used to
// be a brass-bordered card, and a turn of seven calls put seven brass boxes
// between the director's ask and the answer, louder than both. Brass now
// stays with the director's turn; the row only says what the model did and
// opens to the raw result.
const rowStyle: CSSProperties = {
  position: "relative",
  display: "block",
  width: "100%",
  maxWidth: "100%",
  fontSize: 12,
  fontFamily: SANS,
  color: SAGE,
  lineHeight: "1.4",
  boxSizing: "border-box" as const,
};

// The row's line: icon · label · summary on the left, the row's actions and
// its chevron on the right. Pulled into the hairline's gutter by its own
// padding, so the hover wash has room around the text while the icon stays
// aligned with the narration. The chevron is always the last column, so the
// chevrons of a round line up whatever actions a row has.
const lineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: 24,
  padding: "0 6px",
  marginLeft: -6,
  gap: 4,
  borderRadius: 4,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flex: 1,
  minWidth: 0,
  height: "100%",
  gap: 10,
  cursor: "pointer",
  borderRadius: 4,
  color: "inherit",
  fontSize: "inherit",
  fontFamily: "inherit",
  lineHeight: "inherit",
  textAlign: "left" as const,
  boxSizing: "border-box" as const,
};

// A resolved row's verdict, when it isn't a pass: a 6px dot ON the work
// hairline, exactly where the live row's status dot sat (the hairline is
// 12px left of the row: its 1px border plus the block's 12px padding, so
// the dot's centre lands on it), and a mono meta in the slot the live row's
// timer had. Rouge for a failure, mute for a denial. A pass stays unmarked,
// so a turn of twenty good calls carries no noise.
const verdictDotStyle: CSSProperties = {
  position: "absolute",
  left: -15.5,
  top: 9,
  width: 6,
  height: 6,
  borderRadius: 999,
};

const verdictMetaStyle: CSSProperties = {
  fontSize: 9,
  fontFamily: MONO,
  letterSpacing: "0.15em",
  textTransform: "uppercase",
  flexShrink: 0,
  marginLeft: 6,
  whiteSpace: "nowrap",
};

// A row's actions (Send to terminal, Open in editor, Reveal in Finder, Open)
// are 12px icons with a title, shown while the row is hovered or holds focus
// (`.octo-ledger-actions`), mute until hovered, then brass.
const actionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  color: MUTE,
  borderRadius: 4,
  cursor: "pointer",
  flexShrink: 0,
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
  const verdict = toolVerdict(tool);
  const verdictInk = verdict.kind === "failed" ? ROUGE : MUTE;
  const ToolIcon = iconForTool(tool.toolName);
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

  const toggle = () => setExpanded((v) => !v);
  return (
    <div data-role="tool" data-outcome={verdict.kind} className="octo-selectable" style={rowStyle}>
      {verdict.kind !== "ok" && (
        <span
          aria-hidden
          data-testid="tool-verdict-dot"
          title={verdict.title}
          style={{ ...verdictDotStyle, background: verdictInk }}
        />
      )}
      <div className="octo-ledger" style={lineStyle}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          aria-label={[`${label} ${summary}`.trim(), verdict.title].filter(Boolean).join(", ")}
          onClick={toggle}
          onKeyDown={keyActivate(toggle)}
          className="octo-ledger-head"
          style={headerStyle}
        >
          <span
            title={tool.toolName}
            style={{ display: "inline-flex", flexShrink: 0, color: MUTE }}
          >
            <ToolIcon size={12} strokeWidth={1.75} />
          </span>
          <span
            style={{
              fontSize: 9,
              fontFamily: MONO,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: MUTE,
              flexShrink: 0,
              minWidth: 48,
            }}
          >
            {label}
          </span>
          <span
            title={summary}
            style={{
              fontSize: 11,
              fontFamily: MONO,
              color: SAGE,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
              flex: 1,
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
                fontFamily: MONO,
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
          {verdict.kind !== "ok" && (
            <span
              title={verdict.title}
              data-tour={tourId("talk-tool-verdict")}
              className="octo-tabular"
              style={{ ...verdictMetaStyle, color: verdictInk }}
            >
              {verdict.meta}
            </span>
          )}
        </div>

        <span className="octo-ledger-actions" style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
          {command && onRunInTerminal && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onRunInTerminal(command);
              }}
              onKeyDown={keyActivate(() => onRunInTerminal(command))}
              title="Send to terminal (copies the command and switches to Run)"
              aria-label="Send to terminal"
              className="octo-ledger-action"
              style={actionStyle}
            >
              <Terminal size={12} strokeWidth={1.75} aria-hidden />
            </span>
          )}
          {filePath && tool.toolName === "write_file" && onOpenInEditor && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onOpenInEditor(filePath);
              }}
              onKeyDown={keyActivate(() => onOpenInEditor(filePath))}
              title="Open in editor"
              aria-label="Open in editor"
              className="octo-ledger-action"
              style={actionStyle}
            >
              <FilePen size={12} strokeWidth={1.75} aria-hidden />
            </span>
          )}
          {filePath && tool.toolName === "write_file" && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                if (workspacePath) ipc.revealInFinder(`${workspacePath}/${filePath}`);
              }}
              onKeyDown={keyActivate(() => {
                if (workspacePath) ipc.revealInFinder(`${workspacePath}/${filePath}`);
              })}
              title="Reveal in Finder"
              aria-label="Reveal in Finder"
              className="octo-ledger-action"
              style={actionStyle}
            >
              <FolderOpen size={12} strokeWidth={1.75} aria-hidden />
            </span>
          )}
          {filePath && tool.toolName === "write_file" && isWebFile && (
            <span
              role="button"
              tabIndex={0}
              onClick={() => {
                if (workspacePath) ipc.openFileInSystem(`${workspacePath}/${filePath}`);
              }}
              onKeyDown={keyActivate(() => {
                if (workspacePath) ipc.openFileInSystem(`${workspacePath}/${filePath}`);
              })}
              title="Open in the default browser"
              aria-label="Open in the default browser"
              className="octo-ledger-action"
              style={actionStyle}
            >
              <ExternalLink size={12} strokeWidth={1.75} aria-hidden />
            </span>
          )}
        </span>

        {/* The chevron is pointer decoration for the header's toggle, never
            a second tab stop: always the last column, so chevrons align. */}
        <span
          aria-hidden
          onClick={toggle}
          style={{
            display: "inline-flex",
            flexShrink: 0,
            width: 12,
            cursor: "pointer",
            color: MUTE,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform var(--dur-quick) var(--ease-octo)",
          }}
        >
          <ChevronRight size={11} strokeWidth={1.75} />
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "4px 0 10px" }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => copy(tool.result)}
              onKeyDown={keyActivate(() => copy(tool.result))}
              style={{
                fontSize: 9,
                fontFamily: MONO,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: copied ? "var(--color-octo-verdigris)" : MUTE,
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
                  background: `linear-gradient(to bottom, transparent, ${ONYX})`,
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
