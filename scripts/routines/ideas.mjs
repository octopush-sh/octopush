#!/usr/bin/env node
// Daily ideas digest (VISION.md §9). The agent researches and writes ideas as
// JSON; this script does everything deterministic: dedupe context, issue
// creation, ranking, numbering and the digest issue the owner answers.
//
//   ideas.mjs check              exit 0 if today's digest hasn't been posted yet
//   ideas.mjs context            Markdown context for the agent (priorities, every
//                                existing idea for dedupe, items to resurface, what's
//                                waiting for the owner, what shipped this week)
//   ideas.mjs post <ideas.json>  validate, create/resurface the idea issues, post the digest
//
// ideas.json: [{ "title", "area": "app|api|web", "kind": "feature|improvement|fix",
//   "value": 1-5, "difficulty": "S|M|L", "estimate": "e.g. 2–4 h", "why", "proposal",
//   "evidence": ["https://…"], "resurface": <issue number, optional> }, …]  (≥ 5)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGh, ghForRepo, hasWebToken, APP_REPO, API_REPO, WEB_REPO, ALL_REPOS, ciStatus, labelsOf, sanitize, reportFatal } from "./gh.mjs";
import { loadIdentities, requireIdentities, assertActingAs, sameLogin, inActions, idsForRepo } from "./identity.mjs";
import { verdictFor } from "./automerge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_FOR_AREA = { app: APP_REPO, api: API_REPO, web: WEB_REPO };

/**
 * Where an idea is filed. A workflow token can only write to its own repo, so
 * in GitHub Actions ideas live in the app repo, tagged `area:<area>` — except
 * website ideas when the cycle App's token for octopush-web is there
 * (`web`): those are filed in octopush-web itself, where the web builder takes
 * them once approved.
 */
export const repoForIdea = (area, actions = inActions(), web = hasWebToken()) =>
  (!actions ? REPO_FOR_AREA[area] : area === "web" && web ? WEB_REPO : APP_REPO);
export const ideaLabels = (area, actions = inActions(), web = hasWebToken()) =>
  ["proposal", "idea", ...(actions && repoForIdea(area, actions, web) === APP_REPO ? [`area:${area}`] : [])];

/**
 * The repo clients the digest uses: octopush-web with the App token, the rest
 * with the default login. Tests pass one fake for every repo.
 */
export const defaultGhFor = () => {
  const cache = new Map();
  return (repo) => { if (!cache.has(repo)) cache.set(repo, ghForRepo(repo)); return cache.get(repo); };
};

/** The area of an existing idea issue: its `area:` label, else its repo. */
export function areaOf(issue, repo) {
  const l = labelsOf(issue).find((x) => /^area:(app|api|web)$/.test(x));
  if (l) return l.slice(5);
  return repo === APP_REPO ? "app" : repo === API_REPO ? "api" : "web";
}
const DIFF_RANK = { S: 0, M: 1, L: 2 };
/** `octopush#12`, `octopush-web#12`, `octopush-api#12` — as the context lists them. */
const RESURFACE_REF = /^(octopush(?:-web|-api)?)#(\d+)$/;
/**
 * Where a resurfaced idea lives (pure): an explicit `octopush-web#12`, else a
 * bare number in the area's repo (legacy: ideas for every area were filed in
 * the app repo before the web repo had its own token).
 */
export function resurfaceRef(it, actions = inActions(), web = hasWebToken()) {
  const m = RESURFACE_REF.exec(String(it.resurface));
  if (m) return { repo: `${APP_REPO.split("/")[0]}/${m[1]}`, n: Number(m[2]) };
  return { repo: repoForIdea(it.area, actions, web), n: Number(it.resurface) };
}
export const MIN_IDEAS = 5;
const DAY = 864e5;

/**
 * List from another repo, or [] when this token can't read it: a workflow's
 * GITHUB_TOKEN only reaches its own repo, so a private sibling (octopush-api)
 * answers 404. The digest then simply leaves that repo out.
 */
export function listOrEmpty(gh, path, max) {
  try { return gh.list(path, max); } catch { return []; }
}

/** YYYY-MM-DD in the machine's local time zone (the owner's day). */
export function localDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
export const digestTitle = (date) => `Ideas — ${date}`;

/** Shorten a title to ≤ 90 chars at a word boundary (pure). */
export function fitTitle(t) {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= 90) return s;
  const cut = s.slice(0, 89);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 50 ? cut.lastIndexOf(" ") : 89).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Keep what's usable from an agent's ideas.json (pure): fix what can be fixed
 * mechanically (long titles), drop ideas that are still invalid, and fail only
 * when fewer than MIN_IDEAS survive — a whole night's research isn't thrown
 * away for one bad entry. Returns { ideas, dropped, errors }.
 */
export function usableIdeas(raw) {
  if (!Array.isArray(raw)) return { ideas: [], dropped: [], errors: ["ideas.json must be a JSON array"] };
  const fixed = raw.map((it) => (it && typeof it === "object" && typeof it.title === "string" ? { ...it, title: fitTitle(it.title) } : it));
  const ideas = [], dropped = [];
  for (const [i, it] of fixed.entries()) {
    // Validate each alone (count rule off), plus duplicate titles against the kept ones.
    const errs = validateIdeas([it], 1).map((e) => e.replace(/^ideas\[0\]/, `ideas[${i}]`));
    if (!errs.length && ideas.some((k) => k.title.toLowerCase() === it.title.toLowerCase())) errs.push(`ideas[${i}].title duplicates another idea`);
    if (errs.length) dropped.push(...errs); else ideas.push(it);
  }
  const errors = ideas.length < MIN_IDEAS ? [`only ${ideas.length} usable ideas (at least ${MIN_IDEAS})`, ...dropped] : [];
  return { ideas, dropped, errors };
}

export function validateIdeas(ideas, min = MIN_IDEAS) {
  const errs = [];
  if (!Array.isArray(ideas)) return ["ideas.json must be a JSON array"];
  if (ideas.length < min) errs.push(`only ${ideas.length} ideas (at least ${min})`);
  const seen = new Set();
  ideas.forEach((it, i) => {
    const at = `ideas[${i}]`;
    if (typeof it?.title !== "string" || !it.title.trim() || it.title.length > 90) errs.push(`${at}.title: 1–90 chars`);
    else if (seen.has(it.title.toLowerCase())) errs.push(`${at}.title duplicates another idea`);
    else seen.add(it.title.toLowerCase());
    if (!REPO_FOR_AREA[it?.area]) errs.push(`${at}.area: app | api | web`);
    if (!["feature", "improvement", "fix"].includes(it?.kind)) errs.push(`${at}.kind: feature | improvement | fix`);
    if (!Number.isInteger(it?.value) || it.value < 1 || it.value > 5) errs.push(`${at}.value: integer 1–5`);
    if (!Object.hasOwn(DIFF_RANK, it?.difficulty ?? "")) errs.push(`${at}.difficulty: S | M | L`);
    if (typeof it?.estimate !== "string" || !it.estimate.trim()) errs.push(`${at}.estimate: e.g. "2–4 h"`);
    for (const k of ["why", "proposal"]) if (typeof it?.[k] !== "string" || it[k].trim().length < 20) errs.push(`${at}.${k}: at least a sentence`);
    if (it?.evidence !== undefined && (!Array.isArray(it.evidence) || it.evidence.some((u) => !/^https?:\/\//.test(u)))) errs.push(`${at}.evidence: list of URLs`);
    if (it?.resurface !== undefined && !Number.isInteger(it.resurface) && !RESURFACE_REF.test(String(it.resurface))) errs.push(`${at}.resurface: an issue reference like "octopush-web#12" or a number`);
  });
  return errs;
}

/** Highest value first, then easiest, then title (stable). */
export function rank(ideas) {
  return [...ideas].sort((a, b) => b.value - a.value || DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty] || a.title.localeCompare(b.title));
}

export function ideaBody(it, date) {
  // Agent-written text: sanitized so it can't carry a routine marker.
  const ev = (it.evidence ?? []).map((u) => `- ${sanitize(u)}`).join("\n");
  return [
    `**Value** ${"●".repeat(it.value)}${"○".repeat(5 - it.value)} (${it.value}/5) · **Difficulty** ${it.difficulty} · **Estimate** ${sanitize(it.estimate)} · **Kind** ${it.kind}`,
    "", "### Why", sanitize(it.why).trim(), "", "### Proposal", sanitize(it.proposal).trim(),
    ev ? `\n### Evidence\n${ev}` : "",
    "", `_Suggested by the ideas routine on ${date}. Answer it in that day's digest issue._`,
  ].join("\n");
}

/** The digest body; `rows` are [{n, ref, title, area, value, difficulty, estimate, url, earlier?}]. */
export function digestBody({ date, rows, waiting }) {
  const fmt = (r) => `| ${r.n} | [${sanitize(r.title).replace(/\|/g, "\\|")}](${r.url}) | ${r.area} | ${"●".repeat(r.value)} | ${r.difficulty} | ${r.estimate} |`;
  const fresh = rows.filter((r) => !r.earlier), earlier = rows.filter((r) => r.earlier);
  const map = Object.fromEntries(rows.map((r) => [String(r.n), r.ref]));
  return [
    `**${fresh.length} new idea${fresh.length === 1 ? "" : "s"}**, ranked by value, then difficulty. Reply in a comment, one line each:`,
    "",
    "`1 yes` · `2 no` · `3 later` (also `sí`, `aún no`; several at once: `1, 4 yes`) — add a note after it if you like.",
    "`promote 0.4.91` — ship a beta to everyone (you approve it in GitHub). `merge web#12` — publish an approved website PR. `idea: …` — add your own. App and website ideas you approve are built tonight (website PRs wait for your `merge`); API ones are queued until that repo gets a builder.",
    "",
    "| # | Idea | Area | Value | Difficulty | Time |",
    "|---|---|---|---|---|---|",
    ...fresh.map(fmt),
    ...(earlier.length ? ["", "**Still waiting from earlier digests**", "", "| # | Idea | Area | Value | Difficulty | Time |", "|---|---|---|---|---|---|", ...earlier.map(fmt)] : []),
    "",
    "### Needs you",
    waiting.length ? waiting.map((w) => `- ${w}`).join("\n") : "- Nothing else is waiting.",
    "",
    `<!-- octopush-digest:${JSON.stringify(map)} -->`,
  ].join("\n");
}

/** -1 / 0 / 1 comparing X.Y.Z strings numerically. */
export function cmpVersion(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/**
 * Website PRs from the web builder that wait for the owner (pure over `gh`):
 * approved by the web review on their head commit with green CI →
 * `merge web#N`; parked (`needs-owner`) → look at it. PRs still being built or
 * reviewed are the cycle's business, not the owner's.
 */
export function webWaiting(gh, webIds) {
  const out = [];
  for (const p of listOrEmpty(gh, `repos/${WEB_REPO}/pulls?state=open`)) {
    if (!labelsOf(p).includes("agent") || p.draft) continue;
    if (!sameLogin(p.user?.login, webIds.builder) || p.head?.repo?.full_name !== WEB_REPO || p.base?.ref !== "main") continue;
    const link = `[web#${p.number} ${p.title}](${p.html_url})`;
    if (labelsOf(p).includes("needs-owner")) { out.push(`Website PR parked for you: ${link}`); continue; }
    let ci = "unknown", verdict = null;
    try { ci = ciStatus(gh, WEB_REPO, p.head.sha); verdict = verdictFor(gh.list(`repos/${WEB_REPO}/issues/${p.number}/comments`), p.head.sha, webIds.reviewer); } catch { /* not readable */ }
    if (verdict === "approve" && ci === "success") out.push(`${link} · approved by the web review, CI green — reply \`merge web#${p.number}\` to publish it`);
  }
  return out;
}

/** Everything waiting for the owner besides ideas. `ghFor(repo)` reaches octopush-web with the App token. */
export function waitingItems(gh, ids, ghFor = () => gh) {
  const out = [];
  const webGh = ghFor(WEB_REPO);
  // With the App token (or on a Mac) the web review's verdicts are readable;
  // without it, a workflow token can't read the private repo at all.
  out.push(...webWaiting(webGh, idsForRepo(ids, WEB_REPO)));
  for (const p of listOrEmpty(gh, `repos/${API_REPO}/pulls?state=open`)) {
    if (!labelsOf(p).includes("agent") || p.draft) continue;
    if (!sameLogin(p.user?.login, ids.builder) || p.head?.repo?.full_name !== API_REPO || p.base?.ref !== "main") continue;
    // A workflow token may not read another repo's Actions runs: CI is then "unknown".
    let ci = "unknown";
    try { ci = ciStatus(gh, API_REPO, p.head.sha); } catch { /* not readable from here */ }
    out.push(`[api#${p.number} ${p.title}](${p.html_url}) · CI ${ci} — merge it on GitHub`);
  }
  for (const i of listOrEmpty(webGh, `repos/${WEB_REPO}/issues?state=open&labels=needs-owner`)) {
    if (!i.pull_request) out.push(`Website issue needs your call: [web#${i.number} ${i.title}](${i.html_url})`);
  }
  for (const p of gh.list(`repos/${APP_REPO}/pulls?state=open`)) {
    if (labelsOf(p).includes("needs-owner") && sameLogin(p.user?.login, ids.builder)) out.push(`App PR parked for you: [#${p.number} ${p.title}](${p.html_url})`);
  }
  for (const i of gh.list(`repos/${APP_REPO}/issues?state=open&labels=needs-owner`)) {
    if (!i.pull_request) out.push(`Issue needs your call: [#${i.number} ${i.title}](${i.html_url})`);
  }
  const rels = gh.list(`repos/${APP_REPO}/releases`, 30)
    .filter((r) => /^v\d+\.\d+\.\d+$/.test(r.tag_name) && !r.draft)
    .sort((a, b) => cmpVersion(b.tag_name.slice(1), a.tag_name.slice(1)));
  const stable = rels.find((r) => !r.prerelease);
  const beta = rels.find((r) => r.prerelease);
  const ver = (r) => r.tag_name.slice(1);
  if (beta && (!stable || cmpVersion(ver(beta), ver(stable)) > 0)) {
    out.push(`Beta **${ver(beta)}** is not on stable yet${stable ? ` (stable: ${ver(stable)})` : ""} — [notes](${beta.html_url}) · \`promote ${ver(beta)}\``);
  }
  return out;
}

/** Written by the owner or the cycle (in the web repo, the cycle is the App's bot). */
const trustedAuthor = (i, ids, repo = APP_REPO) => { const r = idsForRepo(ids, repo); return [r.owner, r.builder].some((t) => sameLogin(t, i.user?.login)); };

/** An idea may come back only if it's an open, trusted `idea` parked as `later`. */
export function canResurface(issue, ids, repo = APP_REPO) {
  const l = labelsOf(issue ?? {});
  return !!issue && !issue.pull_request && issue.state === "open" && l.includes("later") && l.includes("idea") && trustedAuthor(issue, ids, repo);
}

function context(gh, now, ids, ghFor = () => gh) {
  const vision = readFileSync(join(ROOT, "VISION.md"), "utf8");
  const pri = /## 7\.[\s\S]*?(?=\n## 8\.)/.exec(vision)?.[0] ?? "";
  const lines = ["# Context for today's ideas", "", pri.trim(), "", "## Every existing idea / proposal (do not repeat these)", ""];
  const later = [];
  for (const repo of ALL_REPOS) {
    const g = ghFor(repo);
    for (const i of listOrEmpty(g, `repos/${repo}/issues?state=all&labels=idea`, 500).concat(listOrEmpty(g, `repos/${repo}/issues?state=all&labels=proposal`, 500))) {
      if (i.pull_request) continue;
      const l = labelsOf(i);
      lines.push(`- ${repo.split("/")[1]}#${i.number} [${i.state}${l.length ? `; ${l.join(", ")}` : ""}] ${i.title}`);
      if (canResurface(i, ids, repo) && now - Date.parse(i.updated_at) > 30 * DAY) later.push(`- ${repo.split("/")[1]}#${i.number} ${i.title} (parked ${Math.round((now - Date.parse(i.updated_at)) / DAY)} days ago)`);
    }
  }
  lines.push("", "## Parked as `later` for 30+ days — you may resurface (set `resurface` to the reference as written, e.g. \"octopush-web#12\")", "", later.length ? [...new Set(later)].join("\n") : "- none");
  lines.push("", "## Shipped in the last 7 days", "");
  const since = new Date(now - 7 * DAY).toISOString();
  for (const repo of ALL_REPOS) {
    for (const p of listOrEmpty(ghFor(repo), `repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, 100)) {
      if (p.merged_at && p.merged_at >= since) lines.push(`- ${repo.split("/")[1]}#${p.number} ${p.title}`);
    }
  }
  lines.push("", "## Waiting for the owner (will be listed in the digest automatically)", "", ...waitingItems(gh, ids, ghFor).map((w) => `- ${w}`));
  return lines.join("\n");
}

export function post(gh, file, now, ids, ghFor = () => gh) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`ideas.json is not valid JSON: ${e.message}`); return 2; }
  const { ideas, dropped, errors } = usableIdeas(raw);
  if (errors.length) { console.error(errors.join("\n")); return 2; }
  if (dropped.length) console.error(`dropped ${dropped.length} invalid entr${dropped.length === 1 ? "y" : "ies"}:\n${dropped.join("\n")}`);
  const date = localDate(now);
  const existing = gh.list(`repos/${APP_REPO}/issues?state=all&labels=digest`, 100);
  if (existing.some((i) => i.title === digestTitle(date) && sameLogin(i.user?.login, ids.builder))) { console.error(`${digestTitle(date)} already exists`); return 1; }

  const rows = [];
  let n = 1;
  for (const it of rank(ideas)) {
    let repo = repoForIdea(it.area);
    let issue;
    if (it.resurface) {
      const ref = resurfaceRef(it);
      repo = ref.repo;
      const g = ghFor(repo);
      try { issue = g.get(`repos/${repo}/issues/${ref.n}`); } catch { issue = null; }
      if (!canResurface(issue, ids, repo)) { console.error(`skipping resurface of ${repo}#${ref.n}: not an open trusted idea parked as later`); continue; }
      g.send("POST", `repos/${repo}/issues/${ref.n}/labels`, { labels: ["proposal", "idea"] });
      try { g.send("DELETE", `repos/${repo}/issues/${ref.n}/labels/later`); } catch { /* not labelled */ }
      g.send("POST", `repos/${repo}/issues/${ref.n}/comments`, { body: `Resurfaced in ${digestTitle(date)}.\n\n${ideaBody(it, date)}` });
    } else {
      // Idempotent: a rerun after a partial failure reuses the open idea it
      // already filed — in either repo, so a website idea filed in the app repo
      // before the web token existed is never filed a second time in octopush-web.
      const g = ghFor(repo);
      const same = (r) => (i) => !i.pull_request && i.title === it.title && trustedAuthor(i, ids, r);
      issue = (repo !== APP_REPO ? gh.list(`repos/${APP_REPO}/issues?state=open&labels=idea`, 500).find(same(APP_REPO)) : null);
      if (issue) repo = APP_REPO;
      else issue = listOrEmpty(g, `repos/${repo}/issues?state=open&labels=idea`, 500).find(same(repo))
        ?? g.send("POST", `repos/${repo}/issues`, { title: sanitize(it.title), body: ideaBody(it, date), labels: ideaLabels(it.area) });
    }
    rows.push({ n: n++, ref: `${repo}#${issue.number}`, title: it.title, area: it.area, value: it.value, difficulty: it.difficulty, estimate: it.estimate, url: issue.html_url });
  }
  // Unanswered ideas from earlier digests, so nothing silently drops off the list.
  const listed = new Set(rows.map((r) => r.ref));
  for (const repo of ALL_REPOS) {
    for (const i of listOrEmpty(ghFor(repo), `repos/${repo}/issues?state=open&labels=idea,proposal&sort=created&direction=asc`, 20)) {
      const ref = `${repo}#${i.number}`;
      if (i.pull_request || listed.has(ref) || rows.length >= 25 || !trustedAuthor(i, ids, repo)) continue;
      const m = /\*\*Value\*\* [●○]+ \((\d)\/5\) · \*\*Difficulty\*\* ([SML]) · \*\*Estimate\*\* ([^·]+?) ·/.exec(i.body ?? "");
      rows.push({ n: n++, ref, title: i.title, area: areaOf(i, repo), value: Number(m?.[1] ?? 3), difficulty: m?.[2] ?? "M", estimate: m?.[3]?.trim() ?? "?", url: i.html_url, earlier: true });
    }
  }
  for (const old of existing.filter((i) => i.state === "open" && sameLogin(i.user?.login, ids.builder))) gh.send("PATCH", `repos/${APP_REPO}/issues/${old.number}`, { state: "closed", state_reason: "completed" });
  const digest = gh.send("POST", `repos/${APP_REPO}/issues`, { title: digestTitle(date), body: digestBody({ date, rows, waiting: waitingItems(gh, ids, ghFor) }), labels: ["digest"] });
  console.log(`posted ${digest.html_url} with ${rows.filter((r) => !r.earlier).length} new idea(s)`);
  return 0;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const ids = requireIdentities(loadIdentities());
  const gh = makeGh();
  const now = Date.now();
  if (cmd === "check") {
    const t = digestTitle(localDate(new Date(now)));
    const has = gh.list(`repos/${APP_REPO}/issues?state=all&labels=digest`, 50).some((i) => i.title === t && sameLogin(i.user?.login, ids.builder));
    console.log(has ? `${t} already posted` : `${t} not posted yet`);
    return has ? 1 : 0;
  }
  const ghFor = defaultGhFor();
  if (cmd === "context") { console.log(context(gh, now, ids, ghFor)); return 0; }
  if (cmd === "post" && arg) { assertActingAs(gh, ids.builder, ids); return post(gh, arg, new Date(now), ids, ghFor); }
  console.error("usage: ideas.mjs check | context | post <ideas.json>");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { reportFatal("ideas", e); process.exit(2); });
}
