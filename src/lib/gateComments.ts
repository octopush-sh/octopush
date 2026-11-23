/**
 * Gate comments (#957) — the director's inline comments on a stage's
 * artifact while a Direct run is parked at its gate.
 *
 * A comment is a quoted passage of the artifact plus a note. `at` is where the
 * passage starts in the document's rendered text, so comments always travel in
 * document order, however they were added. Reject and Send back carry them as
 * structured feedback (`composeGateFeedback`); Approve hands them to the next
 * stage as guidance appended to its instructions for that one pass
 * (`withGuidance`, taken out again by `withoutGuidance`). The brief
 * and the stages' output contracts are untouched — only the feedback is richer.
 */
import type { RunStage } from "./ipc";

export interface GateComment {
  id: string;
  /** The passage the director selected, verbatim (whitespace collapsed). */
  quote: string;
  /** What the director says about it. */
  note: string;
  /** Offset of the passage in the document's rendered text. */
  at: number;
  /** Length of the selected passage in that text (before collapsing). */
  len: number;
}

/** Longest quote kept verbatim; longer passages are cut with an ellipsis. */
export const MAX_QUOTE_CHARS = 600;

/** Collapse a selection's whitespace (line breaks, list indents) into one
 *  readable line, cut to `MAX_QUOTE_CHARS`. */
export function normalizeQuote(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUOTE_CHARS ? `${flat.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…` : flat;
}

/** Comments in document order (ties keep the order they were added). Pure. */
export function inDocumentOrder(comments: readonly GateComment[]): GateComment[] {
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.at - b.c.at || a.i - b.i)
    .map((x) => x.c);
}

/** The comments as a numbered list: the quoted passage, then the note. */
function commentList(comments: readonly GateComment[]): string {
  return inDocumentOrder(comments)
    .map((c, i) => `${i + 1}. On "${c.quote}":\n   ${c.note.trim().replace(/\n+/g, "\n   ")}`)
    .join("\n\n");
}

/**
 * The feedback a Reject or Send back carries: the director's comments on the
 * artifact in document order, then the free-text note if there is one. With
 * no comments it is the note unchanged, exactly as before.
 */
export function composeGateFeedback(comments: readonly GateComment[], note: string): string {
  const trimmed = note.trim();
  if (comments.length === 0) return trimmed;
  const head = `The director commented on ${comments.length === 1 ? "one passage" : `${comments.length} passages`} of the output, in document order:`;
  const parts = [head, commentList(comments)];
  if (trimmed) parts.push(`Overall note: ${trimmed}`);
  return parts.join("\n\n");
}

/** The lines that fence a gate's guidance inside a stage's instructions, so
 *  it can be found again and taken out. Keyed by the gate's position: two
 *  gates handing off to one stage keep their own blocks. */
const guidanceStart = (position: number) => `[Director's comments from the gate of stage ${position + 1}, for this pass only]`;
const guidanceEnd = (position: number) => `[End of the director's comments from stage ${position + 1}]`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quoted or typed text that happens to contain a fence line (a comment on
 *  a plan that quotes one, say) must not end the block early, or removal
 *  would stop there and leave the rest behind: its bracket becomes a
 *  parenthesis, which no fence starts with. */
const unfenced = (text: string) =>
  text.replace(/\[(?=End of the director's comments from stage |Director's comments from the gate of stage )/g, "(");

/**
 * A stage's instructions without the guidance a gate left in them. The
 * guidance belongs to one pass of the gate: it is taken out when the gate is
 * decided again (the stage before it ran again with a new output) and when
 * the approve that carried it was refused. Instructions holding no such
 * guidance come back unchanged.
 */
export function withoutGuidance(instructions: string | null, from: Pick<RunStage, "position">): string {
  const own = instructions ?? "";
  const block = new RegExp(`\\s*${escapeRe(guidanceStart(from.position))}[\\s\\S]*?${escapeRe(guidanceEnd(from.position))}\\s*`, "g");
  const out = own.replace(block, "\n\n");
  return out === own ? own : out.trim();
}

/**
 * The next stage's instructions once the director approves with comments:
 * its own instructions (if any), then the comments as guidance from the
 * gate, fenced so `withoutGuidance` can take them out again. Guidance the
 * same gate left on an earlier pass is replaced, never stacked.
 */
export function withGuidance(
  instructions: string | null,
  comments: readonly GateComment[],
  from: Pick<RunStage, "position">,
  fromStage: string,
): string {
  const guidance = [
    guidanceStart(from.position),
    `The director approved ${fromStage} with these comments; take them into account:\n\n${unfenced(commentList(comments))}`,
    guidanceEnd(from.position),
  ].join("\n");
  const own = withoutGuidance(instructions, from).trim();
  return own ? `${own}\n\n${guidance}` : guidance;
}

/**
 * Which parked hand-off the comments belong to: the stage AND this attempt's
 * finish, so a stage that loops back and parks again with a new artifact
 * starts with no comments instead of inheriting ones whose passages are gone.
 */
export function gateKey(stage: Pick<RunStage, "id" | "finishedAt">): string {
  return `${stage.id}:${stage.finishedAt ?? ""}`;
}

/**
 * The stages an approved stage hands off to and that haven't begun — where
 * approve-with-comments guidance goes. As in the orchestrator, a run is a
 * flow graph as soon as ANY stage has `parents`: then a stage follows the
 * gate only when it lists it as a parent (a parentless stage is a root).
 * Only with no `parents` anywhere is the next position the next stage.
 */
export function nextStages(stages: readonly RunStage[], from: Pick<RunStage, "position">): RunStage[] {
  const graph = stages.some((s) => (s.parents?.length ?? 0) > 0);
  return stages.filter(
    (s) =>
      s.status === "pending" &&
      s.startedAt === null &&
      (graph ? (s.parents ?? []).includes(from.position) : s.position === from.position + 1),
  );
}

/** "1 comment" / "3 comments". */
export function commentCount(n: number): string {
  return n === 1 ? "1 comment" : `${n} comments`;
}
