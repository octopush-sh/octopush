// Is main green? (docs/ROUTINES.md "When main is red"). A red main sends every
// PR that merges it red too, and a release cut from it fails, so the cycle
// reacts to it in two places:
//
//   - jobs.mjs (the builder's queue) keeps ONE `ready` issue "main is red: <job>"
//     open while main's CI fails, offers it before any other job, and closes it
//     once main is green again;
//   - automerge.mjs pauses auto-merge while main is red, except for a PR whose
//     head already contains main's head (its green CI then proves the fix).
//
// Pure helpers plus a few reads; every write is done by the caller's client.
// main's CI itself is read by gh.mjs `mainCi` (next to ciStatus), so that
// automerge.mjs needs nothing of this module.
import { APP_REPO, labelsOf, sanitize } from "./gh.mjs";
import { sameLogin } from "./identity.mjs";
import { ciFailureList, formatFailures, NONE } from "./ci-failures.mjs";
import { fence } from "./social.mjs";

/** Ends the body of the cycle's "main is red" issue (agent text can't carry it: sanitize). */
export const MAIN_RED_MARK = "<!-- octopush-main-red -->";
export { mainCi } from "./gh.mjs";

/** The open "main is red" issue the cycle filed, or null. Only the builder's own issues count. */
export function findMainRedIssue(gh, repo, ids) {
  return gh.list(`repos/${repo}/issues?state=open&creator=${encodeURIComponent(ids.builder)}&sort=created&direction=desc`, 300)
    .find((i) => !i.pull_request && sameLogin(i.user?.login, ids.builder) && String(i.body ?? "").trimEnd().endsWith(MAIN_RED_MARK)) ?? null;
}

const MAX_TITLE = 90;
const FENCE_LABEL = "failing CI on main: workflow, job and step names and error lines from its CI logs";
/** "main is red: CI / backend, CI / frontend", shortened to fit an issue title (pure). */
export function mainRedTitle(failures) {
  const jobs = [...new Set((failures ?? []).map((f) => (f.job ? `${f.workflow} / ${f.job}` : f.workflow)))];
  const t = `main is red: ${jobs.length ? jobs.join(", ") : "CI"}`;
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1).replace(/[\s,]+$/, "")}…`;
}

/** The issue's body (pure). The log excerpt is already cleaned and redacted (ci-failures.mjs). */
export function mainRedBody({ repo, redSha, report }) {
  const excerpt = report && report !== NONE ? report : "(no failing job could be read: open the run from the commit's checks)";
  return [
    `CI fails on \`main\` at ${redSha} (https://github.com/${repo}/commit/${redSha}). Every PR that merges main inherits it, and a release cut from it fails.`,
    "",
    "**The work:** make CI on main pass again, with the smallest change that fixes the cause (often two PRs that were each green and broke main together). Don't revert other people's work unless the fix is unclear; say why in the PR.",
    "",
    "While main is red, auto-merge is paused (docs/ROUTINES.md). A PR whose head contains main's head and whose CI is green may still merge: that is how this issue's fix lands. This issue is updated while main stays red and closed by the cycle once it is green.",
    "",
    "## What failed",
    "",
    fence(sanitize(excerpt), FENCE_LABEL),
    "",
    MAIN_RED_MARK,
  ].join("\n");
}

/**
 * Keep the "main is red" issue in step with `health` (from mainCi). Red: open
 * it (label `ready`), or update its title and body; a parked one stays parked.
 * Green: close it with a comment. Unknown: leave it alone. `failures` is
 * `ciFailureList` for the red commit (read here when not given). Returns
 * `{ issue, opened?, closed? }`.
 */
export function syncMainRed(gh, repo, ids, health, { failures } = {}) {
  const open = findMainRedIssue(gh, repo, ids);
  if (health?.state === "green") {
    if (!open) return { issue: null };
    gh.send("POST", `repos/${repo}/issues/${open.number}/comments`, { body: `CI on main is green again at ${health.sha}: closing.` });
    gh.send("PATCH", `repos/${repo}/issues/${open.number}`, { state: "closed", state_reason: "completed" });
    return { issue: null, closed: open.number };
  }
  if (health?.state !== "red" || !health.redSha) return { issue: open };
  let list = failures;
  if (list === undefined) { try { list = ciFailureList(gh, repo, health.redSha); } catch { list = null; } }
  const title = mainRedTitle(list ?? []);
  const body = mainRedBody({ repo, redSha: health.redSha, report: list ? formatFailures(list) : null });
  if (!open) {
    const issue = gh.send("POST", `repos/${repo}/issues`, { title, body, labels: ["ready"] });
    return { issue: { ...issue, title, body, labels: [{ name: "ready" }], user: { login: ids.builder } }, opened: true };
  }
  if (open.title !== title || String(open.body ?? "").trimEnd() !== body) gh.send("PATCH", `repos/${repo}/issues/${open.number}`, { title, body });
  return { issue: { ...open, title, body } };
}

/** Is the issue still for the builder to take (open, `ready`, not parked)? (pure) */
export const takeable = (issue) => !!issue && labelsOf(issue).includes("ready") && !labelsOf(issue).some((l) => ["needs-owner", "proposal", "later"].includes(l));
