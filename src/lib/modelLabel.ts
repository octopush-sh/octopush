/** A short, human model id for chips and meta lines: drop the provider prefix
 *  (`claude-` → "", `gpt-` → "GPT ") and the trailing date suffix noise. Shared
 *  so every surface shortens the same way — an escalation to a GPT model reads
 *  "GPT 5.1", not the raw id. */
export function shortModel(model: string): string {
  return model
    .replace("claude-", "")
    .replace("gpt-", "GPT ")
    .replace(/-\d{8}$/, "");
}

/** The note on a stage that ran on another model than it asked for (#791):
 *  "ran on sonnet-5-5". */
export function ranOnNote(ranModel: string): string {
  return `ran on ${shortModel(ranModel)}`;
}

/** Its tooltip: what was asked, what ran, and what the cost is for. */
export function ranOnTitle(askedModel: string, ranModel: string): string {
  return `This stage asked for ${askedModel}, but Claude Code ran it on ${ranModel}: its model settings picked another model. The stage's cost is for ${ranModel}.`;
}
