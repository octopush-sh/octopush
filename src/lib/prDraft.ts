import type { BranchList, FileEdit } from "./types";

export const PR_SYSTEM = `You write GitHub pull request descriptions from a branch's diff. Output ONLY: the PR title on the first line (<=72 characters, imperative, no trailing period), a blank line, then the Markdown body. If a pull request template is given, fill in that template — keep its headings and checklists, answer each section, leave a checklist item unchecked when the input doesn't show it was done. Otherwise use the sections "## Summary", "## Changes", "## How it was built" and "## Testing". Report provenance and test results only from the input; never invent them. No backticks around the whole output, no "Here is", no closing notes.`;

const MAX_DIFF = 12000;

/** A linked ticket's effect on the PR: a GitHub issue closes (`#42`,
 *  `owner/repo#42`), a Jira-style key (`OCTO-12`) prefixes the title. */
export function issueRef(key: string | null | undefined): { closes?: string; titlePrefix?: string } {
  const k = key?.trim() ?? "";
  if (/^#?\d+$/.test(k)) return { closes: `#${k.replace(/^#/, "")}` };
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(k)) return { closes: k };
  if (/^[A-Z][A-Z0-9]+-\d+$/.test(k)) return { titlePrefix: k };
  return {};
}

export interface ProvenanceTurn {
  messageId: number;
  model: string | null;
  files: string[];
}

/** Agent turns whose edits touched the branch's changed files, newest first —
 *  the same matching the Companion's "How this change was built" uses. */
export function provenanceTurns(edits: FileEdit[], changedPaths: string[]): Omit<ProvenanceTurn, "model">[] {
  const matches = (p: string) =>
    changedPaths.some((c) => p === c || p.endsWith("/" + c) || c.endsWith("/" + p));
  const turns = new Map<number, { messageId: number; files: string[]; latest: number }>();
  for (const e of edits) {
    if (e.messageId == null || !matches(e.filePath)) continue;
    const t = turns.get(e.messageId) ?? { messageId: e.messageId, files: [], latest: 0 };
    if (!t.files.includes(e.filePath)) t.files.push(e.filePath);
    const ts = Date.parse(e.createdAt);
    if (!Number.isNaN(ts)) t.latest = Math.max(t.latest, ts);
    turns.set(e.messageId, t);
  }
  return [...turns.values()].sort((a, b) => b.latest - a.latest).map(({ messageId, files }) => ({ messageId, files }));
}

/** Paths a unified diff touches (`diff --git a/x b/x` → `x`). */
export function diffPaths(diff: string): string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) out.push(m[1]);
  return out;
}

export function provenanceSummary(turns: ProvenanceTurn[]): string {
  if (turns.length === 0) return "";
  const lines = turns.slice(0, 12).map((t) => {
    const files = t.files.map((f) => f.split("/").pop()).join(", ");
    return `- ${t.model ?? "unknown model"}: ${files}`;
  });
  const more = turns.length > 12 ? `\n- …and ${turns.length - 12} more turns` : "";
  return `${turns.length} agent turn${turns.length !== 1 ? "s" : ""} shaped this change:\n${lines.join("\n")}${more}`;
}

export function buildPrPrompt(input: {
  diff: string;
  commits: string[];
  template: string | null;
  task?: string | null;
  issueKey?: string | null;
  provenance?: string;
}): string {
  const diff =
    input.diff.length > MAX_DIFF
      ? input.diff.slice(0, MAX_DIFF) + "\n… (diff truncated for the prompt) …"
      : input.diff;
  const parts = [`Write the pull request for this branch.`];
  if (input.task?.trim()) parts.push(`Task:\n${input.task.trim()}`);
  if (input.issueKey?.trim()) parts.push(`Linked ticket: ${input.issueKey.trim()}`);
  if (input.commits.length) parts.push(`Commits (newest first):\n${input.commits.map((c) => `- ${c}`).join("\n")}`);
  parts.push(
    input.provenance
      ? `How it was built (from Octopush's edit tracking):\n${input.provenance}`
      : `How it was built: no agent edits were tracked for these files.`,
  );
  parts.push(`Testing: no test run was recorded — leave the testing section for the author to fill in.`);
  if (input.template) parts.push(`Pull request template to fill in:\n${input.template}`);
  parts.push(`Diff:\n${diff}`);
  return parts.join("\n\n");
}

/** Split the model's reply into title + body and apply the ticket rules: a
 *  Jira key prefixes the title once, a GitHub issue adds `Closes #N` once. */
export function parsePrDraft(text: string, issueKey?: string | null): { title: string; body: string } {
  const trimmed = text.trim().replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1");
  const nl = trimmed.indexOf("\n");
  let title = (nl === -1 ? trimmed : trimmed.slice(0, nl)).replace(/^#+\s*/, "").replace(/^title:\s*/i, "").trim();
  let body = nl === -1 ? "" : trimmed.slice(nl + 1).trim();
  const ref = issueRef(issueKey);
  if (ref.titlePrefix && !title.includes(ref.titlePrefix)) title = `${ref.titlePrefix}: ${title}`;
  if (ref.closes && !new RegExp(`\\b(closes|fixes|resolves)\\s+${escapeRe(ref.closes)}\\b`, "i").test(body)) {
    body = `Closes ${ref.closes}\n\n${body}`.trim();
  }
  return { title, body };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const bare = (b: string) => b.replace(/^origin\//, "");

/** Whether `head` can open a pull request: a named branch that isn't the
 *  repository's default branch (`list.repoDefault`; `list.local[0]` is only the
 *  checked-out branch). */
export function canOpenPrFrom(head: string | null | undefined, list: Pick<BranchList, "repoDefault">): boolean {
  if (!head || head === "HEAD") return false;
  return !list.repoDefault || head !== list.repoDefault;
}

/** The base a PR from `head` targets: the workspace's own base, else the repo's
 *  default — never `head` itself (that would only push the base branch). */
export function prBaseFor(
  head: string | null | undefined,
  fromBranch: string | null | undefined,
  list: Pick<BranchList, "repoDefault">,
): string | null {
  for (const b of [fromBranch, list.repoDefault]) {
    if (b && bare(b) !== head) return b;
  }
  return null;
}
