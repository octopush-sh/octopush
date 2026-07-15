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
