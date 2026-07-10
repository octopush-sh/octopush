import type { ChatMessage } from "./types";

/**
 * Render a conversation's messages as portable Markdown for export (copy to
 * clipboard). User/assistant turns become labeled sections; tool rows render as
 * a `§ TOOL` block with their parsed input + result. Mirrors what the timeline
 * shows, so the export reads like the on-screen conversation.
 */
export function conversationToMarkdown(title: string, messages: ChatMessage[]): string {
  const lines: string[] = [`# ${title || "Conversation"}`, ""];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push("## You", "", m.content.trim(), "");
    } else if (m.role === "assistant") {
      const model = m.model ? ` _(${m.model})_` : "";
      lines.push(`## Octopus${model}`, "", m.content.trim(), "");
    } else if (m.role === "error") {
      lines.push("> **Error:** " + m.content.trim(), "");
    } else if (m.role === "stopped") {
      lines.push("> _(stopped)_", "");
    } else if (m.role === "tool") {
      lines.push(...toolToMarkdown(m.content));
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function toolToMarkdown(raw: string): string[] {
  try {
    const t = JSON.parse(raw) as {
      toolName?: string;
      toolInput?: Record<string, unknown>;
      result?: string;
    };
    const name = (t.toolName ?? "tool").toUpperCase();
    const out: string[] = [`### § ${name}`, ""];
    const cmd =
      t.toolName === "run_command" ? String(t.toolInput?.command ?? "") : "";
    if (cmd) out.push("```sh", `$ ${cmd}`, "```", "");
    if (t.result) out.push("```", String(t.result).trimEnd(), "```", "");
    return out;
  } catch {
    // Not JSON — emit the raw content so nothing is lost.
    return ["```", raw.trim(), "```", ""];
  }
}
