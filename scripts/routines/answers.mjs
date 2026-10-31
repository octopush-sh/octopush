#!/usr/bin/env node
// Apply the owner's answers to the ideas digest (VISION.md §9).
//
//   answers.mjs check   exit 0 when an open digest has an owner comment not applied yet
//   answers.mjs apply   apply every unapplied owner comment and reply with a summary
//
// Only comments by the owner account count; the script acts as the builder.
// Grammar (one instruction per line or ';'; case and accents don't matter):
//   1 yes | 2 no | 3 later        also sí/si/ok/dale, aún no/luego/después/not yet;
//   1, 4 y 6 sí — una nota        several numbers; text after the verb is a note
//   merge web#12 | merge api#5    merge a waiting website/API PR. A website PR is merged with the
//                                 cycle App's token only if it is still what the web review
//                                 approved: CI green and an approving verdict on its exact head,
//                                 no human-only path (automerge.mjs webMergeRefusals)
//   promote 0.4.91                dispatch the stable promotion workflow
//   idea: <text>                  file a new idea for tomorrow's digest to estimate
import { makeGh, ghForRepo, hasWebToken, APP_REPO, API_REPO, WEB_REPO, ciStatus, labelsOf, reportFatal } from "./gh.mjs";
import { loadIdentities, requireIdentities, assertActingAs, sameLogin, inActions, idsForRepo } from "./identity.mjs";
import { verdictFor, webMergeRefusals } from "./automerge.mjs";

const MARK = "<!-- octopush-";
// No bare "y": in Spanish it means "and" ("4 y 5 sí").
const YES = ["si", "yes", "ok", "dale", "aprobado", "approve"];
const NO = ["no", "n", "nope", "descartar", "reject"];
const LATER = ["aun no", "later", "luego", "despues", "mas tarde", "not yet", "todavia no"];

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const VERBS = [...YES, ...NO, ...LATER].sort((a, b) => b.length - a.length).map((v) => v.replace(/ /g, "\\s+")).join("|");
// "1 sí", "4, 6 y 7 yes", "2: no" — numbers not preceded by '#', then a verdict word.
const ITEM = new RegExp(`(?<![#\\w])((?:\\d+\\s*(?:,|\\by\\b|\\band\\b|&)?\\s*)*\\d+)\\s*[:.)\\-]?\\s*(${VERBS})(?![\\w])`, "g");
const COMMAND = /^(?:merge|mergea|mergear|promote|promover|promueve|idea\s*:)/;

/**
 * Parse one comment into actions. Pure.
 * Lines are split on newlines, and on ';' only where a new instruction starts,
 * so a note may contain ';'. Within a line, every "<numbers> <verdict>" is an
 * instruction; the text after one (up to the next) is its note.
 */
export function parseAnswers(text) {
  const actions = [], unknown = [];
  const pieces = [];
  for (const raw of text.split(/\r?\n/)) {
    let buf = "";
    for (const part of raw.split(";")) {
      const f = fold(part.replace(/^\s*[-*>]\s*/, ""));
      if (buf && (COMMAND.test(f) || /^\d+\s*(?:[,:.)\-]|\s)/.test(f))) { pieces.push(buf); buf = part; }
      else buf = buf ? `${buf};${part}` : part;
    }
    if (buf) pieces.push(buf);
  }
  for (const piece of pieces) {
    const line = piece.replace(/^\s*[-*>]\s*/, "").trim();
    if (!line) continue;
    const f = fold(line);
    let m;
    if ((m = /^(?:merge|mergea|mergear)\s+(?:octopush-)?(web|api)\s*#\s*(\d+)\s*$/.exec(f))) {
      actions.push({ type: "merge", repo: m[1] === "web" ? WEB_REPO : API_REPO, n: Number(m[2]) });
      continue;
    }
    if ((m = /^(?:promote|promover|promueve)\s+v?(\d+\.\d+\.\d+)\s*$/.exec(f))) {
      actions.push({ type: "promote", version: m[1] });
      continue;
    }
    if ((m = /^idea\s*:\s*(.+)$/i.exec(line))) {
      actions.push({ type: "idea", text: m[1].trim() });
      continue;
    }
    // fold() keeps length for Latin text (NFD then strip marks), so map by recomputing on the original.
    const hits = [...f.matchAll(ITEM)];
    if (!hits.length || f.slice(0, hits[0].index).replace(/[\s,.;:]+/g, "")) { unknown.push(line); continue; }
    hits.forEach((h, k) => {
      const verb = h[2].replace(/\s+/g, " ");
      const verdict = YES.includes(verb) ? "yes" : NO.includes(verb) ? "no" : "later";
      const from = h.index + h[0].length, to = k + 1 < hits.length ? hits[k + 1].index : f.length;
      const raw = foldedSlice(line, f, from, to).replace(/^[\s,:;.—–-]+|[\s,;—–-]+$/g, "");
      // Punctuation alone ("1 sí.") is not a note.
      const note = /[\p{L}\p{N}]/u.test(raw) ? raw : "";
      for (const n of h[1].match(/\d+/g)) actions.push({ type: "verdict", n: Number(n), verdict, note });
    });
  }
  return { actions, unknown };
}

/** The original-text substring that corresponds to folded[from, to). */
function foldedSlice(original, folded, from, to) {
  // Build an index map from folded positions to original positions.
  const map = [];
  let fi = 0;
  for (let oi = 0; oi < original.length; oi++) {
    const fc = original[oi].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    for (let k = 0; k < fc.length; k++) map[fi++] = oi;
  }
  const lead = original.length - original.trimStart().length;
  const a = map[from + 0] ?? original.length, b = to >= folded.length ? original.length : map[to] ?? original.length;
  return original.slice(Math.max(a, lead), b).trim();
}

export const digestMap = (body) => {
  const m = /<!-- octopush-digest:(\{.*?\}) -->/.exec(body ?? "");
  return m ? JSON.parse(m[1]) : {};
};
const appliedIds = (comments) => new Set(comments.flatMap((c) => [...(c.body ?? "").matchAll(/<!-- octopush-applied:(\d+) -->/g)].map((m) => m[1])));

/** Owner comments on a digest that haven't been applied. */
export function pending(comments, owner) {
  const done = appliedIds(comments);
  return comments.filter((c) => sameLogin(c.user?.login, owner) && !(c.body ?? "").includes(MARK) && !done.has(String(c.id)));
}

function splitRef(ref) {
  const [repo, n] = ref.split("#");
  return { repo, n: Number(n) };
}

/** Stable release tags (non-prerelease) and prereleases, newest first. */
const semver = (v) => v.replace(/^v/, "").split(".").map(Number);
export const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

function applyOne(gh, digest, action, ids, ghFor) {
  const link = `[${digest.title}](${digest.html_url})`;
  if (action.type === "verdict") {
    const ref = digestMap(digest.body)[String(action.n)];
    if (!ref) return `${action.n}: no such item in this digest`;
    const { repo, n } = splitRef(ref);
    if (![APP_REPO, API_REPO, WEB_REPO].includes(repo) || !Number.isInteger(n)) return `${action.n}: not a cycle issue`;
    gh = ghFor(repo); // octopush-web is written with the cycle App's token
    const note = action.note ? `\n\n> ${action.note}` : "";
    const drop = (label) => { try { gh.send("DELETE", `repos/${repo}/issues/${n}/labels/${label}`); } catch { /* absent */ } };
    if (action.verdict === "yes") {
      gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["ready"] });
      drop("proposal"); drop("later");
      gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Approved by the owner in ${link} — the nightly builders will pick it up.${note}` });
      return `${action.n} → **ready** (${ref})${action.note ? ` — note: “${action.note}”` : ""}`;
    }
    if (action.verdict === "no") {
      gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["wontfix"] });
      gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Declined by the owner in ${link}.${note}` });
      gh.send("PATCH", `repos/${repo}/issues/${n}`, { state: "closed", state_reason: "not_planned" });
      return `${action.n} → closed (${ref})${action.note ? ` — note: “${action.note}”` : ""}`;
    }
    gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["later"] });
    drop("proposal");
    gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Parked as **later** by the owner in ${link}; it may come back in a month.${note}` });
    return `${action.n} → later (${ref})${action.note ? ` — note: “${action.note}”` : ""}`;
  }
  if (action.type === "merge" && action.repo === WEB_REPO && (hasWebToken() || !inActions())) return mergeWeb(ghFor(WEB_REPO), action.n, ids);
  if (action.type === "merge") {
    const pr = gh.get(`repos/${action.repo}/pulls/${action.n}`);
    const short = action.repo.endsWith("-web") ? "web" : "api";
    if (pr.state !== "open") return `merge ${short}#${action.n}: not open`;
    if (!sameLogin(pr.user?.login, ids.builder)) return `merge ${short}#${action.n}: not opened by the builder account — merge it yourself`;
    if (!labelsOf(pr).includes("agent")) return `merge ${short}#${action.n}: not labelled \`agent\``;
    if (pr.base?.ref !== "main" || pr.head?.repo?.full_name !== action.repo) return `merge ${short}#${action.n}: must be a same-repo PR into main`;
    const ci = ciStatus(gh, action.repo, pr.head.sha);
    if (ci !== "success") return `merge ${short}#${action.n}: CI is ${ci} — not merged`;
    // A workflow token only reaches its own repo: from Actions the owner merges
    // website/API PRs with one click (merging them deploys).
    if (inActions()) return `merge ${short}#${action.n}: checks pass — merge it on GitHub: ${pr.html_url}`;
    const r = gh.send("PUT", `repos/${action.repo}/pulls/${action.n}/merge`, { merge_method: "merge", sha: pr.head.sha });
    return r?.merged ? `merged ${short}#${action.n} (it deploys at the next deploy window)` : `merge ${short}#${action.n}: ${r?.message ?? "failed"}`;
  }
  if (action.type === "promote") {
    let rel;
    try { rel = gh.get(`repos/${APP_REPO}/releases/tags/v${action.version}`); } catch { rel = null; }
    if (!rel?.prerelease) return `promote ${action.version}: no beta (prerelease) v${action.version} — nothing promoted`;
    let stable = null;
    try { stable = gh.get(`repos/${APP_REPO}/releases/latest`)?.tag_name; } catch { /* none yet */ }
    if (stable && !newer(action.version, stable)) return `promote ${action.version}: not newer than stable ${stable}`;
    try {
      gh.send("POST", `repos/${APP_REPO}/actions/workflows/promote.yml/dispatches`, { ref: "main", inputs: { version: action.version } });
      return `promotion of ${action.version} to stable started — approve it in GitHub (the \`stable\` environment asks you) and it ships`;
    } catch (e) {
      return `promote ${action.version}: could not start the promote workflow (${String(e.message).split("\n")[0]})`;
    }
  }
  if (action.type === "idea") {
    const title = action.text.length > 80 ? `${action.text.slice(0, 77)}…` : action.text;
    const i = gh.send("POST", `repos/${APP_REPO}/issues`, {
      title, labels: ["proposal", "idea", "owner-idea"],
      body: `${action.text}\n\n_Added by the owner in ${link}. Tomorrow's digest estimates its value, difficulty and time._`,
    });
    return `new idea filed: #${i.number}`;
  }
  return "unknown action";
}

/**
 * `merge web#N`: the owner's OK for a website PR (merging publishes it). Merged
 * with `webGh` (the App token in Actions) only after re-checking, on the PR's
 * current head, every rule the review relied on.
 */
export function mergeWeb(webGh, n, ids, { waitMs = 3000, tries = 5 } = {}) {
  const webIds = idsForRepo(ids, WEB_REPO);
  // GitHub computes mergeability lazily (null right after main moves): ask again briefly.
  let pr = webGh.get(`repos/${WEB_REPO}/pulls/${n}`);
  for (let i = 1; pr.mergeable === null && i < tries; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    pr = webGh.get(`repos/${WEB_REPO}/pulls/${n}`);
  }
  const files = webGh.list(`repos/${WEB_REPO}/pulls/${n}/files`, 3000);
  const ci = ciStatus(webGh, WEB_REPO, pr.head.sha);
  const verdict = verdictFor(webGh.list(`repos/${WEB_REPO}/issues/${n}/comments`), pr.head.sha, webIds.reviewer);
  const why = webMergeRefusals({ pr, files, ci, verdict, ids: webIds });
  if (why.length) return `merge web#${n}: not merged — ${why.join("; ")}${pr.html_url ? ` (${pr.html_url})` : ""}`;
  // `sha` pins the merge to the commit just checked: if it moved since, GitHub refuses.
  const r = webGh.send("PUT", `repos/${WEB_REPO}/pulls/${n}/merge`, { merge_method: "merge", sha: pr.head.sha });
  return r?.merged ? `merged web#${n} at ${pr.head.sha.slice(0, 7)} — it goes live at the next deploy window, once CI passes on main` : `merge web#${n}: ${r?.message ?? "failed"}`;
}

/** Recent digests, only those the builder account opened. */
export const digests = (gh, ids) =>
  gh.list(`repos/${APP_REPO}/issues?state=all&labels=digest&sort=created&direction=desc`, 5).filter((d) => sameLogin(d.user?.login, ids.builder));

export function applyAll(gh, ids, ghFor = () => gh) {
  let applied = 0;
  for (const d of digests(gh, ids)) {
    const comments = gh.list(`repos/${APP_REPO}/issues/${d.number}/comments`);
    for (const c of pending(comments, ids.owner)) {
      const { actions, unknown } = parseAnswers(c.body ?? "");
      const results = actions.map((a) => { try { return applyOne(gh, d, a, ids, ghFor); } catch (e) { return `${a.type}: error — ${String(e.message).split("\n")[0]}`; } });
      const lines = [...results.map((r) => `- ${r}`), ...unknown.map((u) => `- didn't understand: “${u}”`)];
      gh.send("POST", `repos/${APP_REPO}/issues/${d.number}/comments`, {
        body: `${lines.length ? lines.join("\n") : "- nothing to apply"}\n\n<!-- octopush-applied:${c.id} -->`,
      });
      applied++;
    }
  }
  return applied;
}

async function main() {
  const cmd = process.argv[2];
  const ids = requireIdentities(loadIdentities());
  const gh = makeGh();
  if (cmd === "check") {
    for (const d of digests(gh, ids)) {
      if (pending(gh.list(`repos/${APP_REPO}/issues/${d.number}/comments`), ids.owner).length) { console.log(`answers waiting on #${d.number}`); return 0; }
    }
    console.log("no new answers");
    return 1;
  }
  if (cmd === "apply") {
    assertActingAs(gh, ids.builder, ids);
    const web = ghForRepo(WEB_REPO);
    console.log(`applied ${applyAll(gh, ids, (repo) => (repo === WEB_REPO ? web : gh))} comment(s)`);
    return 0;
  }
  console.error("usage: answers.mjs check | apply");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { reportFatal("answers", e); process.exit(2); });
}
