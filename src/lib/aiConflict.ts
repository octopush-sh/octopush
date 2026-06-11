/**
 * aiConflict — prompt building + output cleanup for AI merge-conflict
 * resolution (G7 slice II). Pure helpers; the IPC call lives in
 * ConflictAiModal.
 */

export const CONFLICT_SYSTEM = `You are a senior software engineer resolving a git merge conflict. You receive one file that contains conflict markers (<<<<<<<, =======, >>>>>>>). Resolve EVERY conflict block, preserving the intent of both sides whenever possible — combine them when they are compatible, choose the more complete version when they are not. Output ONLY the complete merged file content. No code fences, no commentary, no explanations.`;

/** Files larger than this are not sent to the model. */
export const MAX_CONFLICT_CHARS = 48_000;

export function buildConflictPrompt(fileName: string, content: string): string {
  if (content.length > MAX_CONFLICT_CHARS) {
    throw new Error(
      `This file is too large for AI resolution (${content.length.toLocaleString()} characters; the limit is ${MAX_CONFLICT_CHARS.toLocaleString()}).`,
    );
  }
  return `Resolve the merge conflicts in this file.\n\nFile: ${fileName}\n\n${content}`;
}

/** Cleans an accidental wrapping code fence from the model output. Interior
 *  fences (the file's own content) are left untouched. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return text;
  const lines = trimmed.split("\n");
  if (lines.length < 2 || lines[lines.length - 1].trim() !== "```") return text;
  return lines.slice(1, -1).join("\n") + "\n";
}
