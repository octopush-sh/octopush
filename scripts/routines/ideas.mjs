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
import { makeGh, APP_REPO, API_REPO, WEB_REPO, ALL_REPOS, ciStatus, labelsOf } from "./gh.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_FOR_AREA = { app: APP_REPO, api: API_REPO, web: WEB_REPO };
const DIFF_RANK = { S: 0, M: 1, L: 2 };
export const MIN_IDEAS = 5;
const DAY = 864e5;

/** YYYY-MM-DD in the machine's local time zone (the owner's day). */
export function localDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
export const digestTitle = (date) => `Ideas — ${date}`;

export function validateIdeas(ideas) {
  const errs = [];
  if (!Array.isArray(ideas)) return ["ideas.json must be a JSON array"];
  if (ideas.length < MIN_IDEAS) errs.push(`only ${ideas.length} ideas (at least ${MIN_IDEAS})`);
  const seen = new Set();
  ideas.forEach((it, i) => {
    const at = `ideas[${i}]`;
    if (typeof it?.title !== "string" || !it.title.trim() || it.title.length > 90) errs.push(`${at}.title: 1–90 chars`);
    else if (seen.has(it.title.toLowerCase())) errs.push(`${at}.title duplicates another idea`);
    else seen.add(it.title.toLowerCase());
    if (!REPO_FOR_AREA[it?.area]) errs.push(`${at}.area: app | api | web`);
    if (!["feature", "improvement", "fix"].includes(it?.kind)) errs.push(`${at}.kind: feature | improvement | fix`);
    if (!Number.isInteger(it?.value) || it.value < 1 || it.value > 5) errs.push(`${at}.value: integer 1–5`);
    if (!(it?.difficulty in DIFF_RANK)) errs.push(`${at}.difficulty: S | M | L`);
    if (typeof it?.estimate !== "string" || !it.estimate.trim()) errs.push(`${at}.estimate: e.g. "2–4 h"`);
    for (const k of ["why", "proposal"]) if (typeof it?.[k] !== "string" || it[k].trim().length < 20) errs.push(`${at}.${k}: at least a sentence`);
    if (it?.evidence !== undefined && (!Array.isArray(it.evidence) || it.evidence.some((u) => !/^https?:\/\//.test(u)))) errs.push(`${at}.evidence: list of URLs`);
    if (it?.resurface !== undefined && !Number.isInteger(it.resurface)) errs.push(`${at}.resurface: an issue number`);
  });
  return errs;
}

/** Highest value first, then easiest, then title (stable). */
export function rank(ideas) {
  return [...ideas].sort((a, b) => b.value - a.value || DIFF_RANK[a.difficulty] - DIFF_RANK[b.difficulty] || a.title.localeCompare(b.title));
}

export function ideaBody(it, date) {
  const ev = (it.evidence ?? []).map((u) => `- ${u}`).join("\n");
  return [
    `**Value** ${"●".repeat(it.value)}${"○".repeat(5 - it.value)} (${it.value}/5) · **Difficulty** ${it.difficulty} · **Estimate** ${it.estimate} · **Kind** ${it.kind}`,
    "", "### Why", it.why.trim(), "", "### Proposal", it.proposal.trim(),
    ev ? `\n### Evidence\n${ev}` : "",
    "", `_Suggested by the ideas routine on ${date}. Answer it in that day's digest issue._`,
  ].join("\n");
}

/** The digest body; `rows` are [{n, ref, title, area, value, difficulty, estimate, url, earlier?}]. */
export function digestBody({ date, rows, waiting }) {
  const fmt = (r) => `| ${r.n} | [${r.title.replace(/\|/g, "\\|")}](${r.url}) | ${r.area} | ${"●".repeat(r.value)} | ${r.difficulty} | ${r.estimate} |`;
  const fresh = rows.filter((r) => !r.earlier), earlier = rows.filter((r) => r.earlier);
  const map = Object.fromEntries(rows.map((r) => [String(r.n), r.ref]));
  return [
    `**${fresh.length} new idea${fresh.length === 1 ? "" : "s"}**, ranked by value, then difficulty. Reply in a comment, one line each:`,
    "",
    "`1 yes` · `2 no` · `3 later` (also `sí`, `aún no`; several at once: `1, 4 yes`) — add a note after it if you like.",
    "`merge web#12` / `merge api#5` — merge a waiting website/API PR. `promote 0.4.91` — ship a beta to everyone. `idea: …` — add your own.",
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

/** Everything waiting for the owner besides ideas. */
export function waitingItems(gh) {
  const out = [];
  for (const repo of [API_REPO, WEB_REPO]) {
    for (const p of gh.list(`repos/${repo}/pulls?state=open`)) {
      if (!labelsOf(p).includes("agent") || p.draft) continue;
      const short = repo.endsWith("-web") ? "web" : "api";
      out.push(`\`merge ${short}#${p.number}\` — [${p.title}](${p.html_url}) · CI ${ciStatus(gh, repo, p.head.sha)}`);
    }
  }
  for (const p of gh.list(`repos/${APP_REPO}/pulls?state=open`)) {
    if (labelsOf(p).includes("needs-owner")) out.push(`App PR parked for you: [#${p.number} ${p.title}](${p.html_url})`);
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

function context(gh, now) {
  const vision = readFileSync(join(ROOT, "VISION.md"), "utf8");
  const pri = /## 7\.[\s\S]*?(?=\n## 8\.)/.exec(vision)?.[0] ?? "";
  const lines = ["# Context for today's ideas", "", pri.trim(), "", "## Every existing idea / proposal (do not repeat these)", ""];
  const later = [];
  for (const repo of ALL_REPOS) {
    for (const i of gh.list(`repos/${repo}/issues?state=all&labels=idea`, 500).concat(gh.list(`repos/${repo}/issues?state=all&labels=proposal`, 500))) {
      if (i.pull_request) continue;
      const l = labelsOf(i);
      lines.push(`- ${repo.split("/")[1]}#${i.number} [${i.state}${l.length ? `; ${l.join(", ")}` : ""}] ${i.title}`);
      if (i.state === "open" && l.includes("later") && now - Date.parse(i.updated_at) > 30 * DAY) later.push(`- ${repo.split("/")[1]}#${i.number} ${i.title} (parked ${Math.round((now - Date.parse(i.updated_at)) / DAY)} days ago)`);
    }
  }
  lines.push("", "## Parked as `later` for 30+ days — you may resurface (set `resurface`)", "", later.length ? [...new Set(later)].join("\n") : "- none");
  lines.push("", "## Shipped in the last 7 days", "");
  const since = new Date(now - 7 * DAY).toISOString();
  for (const repo of ALL_REPOS) {
    for (const p of gh.list(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, 100)) {
      if (p.merged_at && p.merged_at >= since) lines.push(`- ${repo.split("/")[1]}#${p.number} ${p.title}`);
    }
  }
  lines.push("", "## Waiting for the owner (will be listed in the digest automatically)", "", ...waitingItems(gh).map((w) => `- ${w}`));
  return lines.join("\n");
}

function post(gh, file, now) {
  const ideas = JSON.parse(readFileSync(file, "utf8"));
  const errs = validateIdeas(ideas);
  if (errs.length) { console.error(errs.join("\n")); return 2; }
  const date = localDate(now);
  const existing = gh.list(`repos/${APP_REPO}/issues?state=all&labels=digest`, 100);
  if (existing.some((i) => i.title === digestTitle(date))) { console.error(`${digestTitle(date)} already exists`); return 1; }

  const rows = [];
  let n = 1;
  for (const it of rank(ideas)) {
    const repo = REPO_FOR_AREA[it.area];
    let issue;
    if (it.resurface) {
      issue = gh.get(`repos/${repo}/issues/${it.resurface}`);
      gh.send("POST", `repos/${repo}/issues/${it.resurface}/labels`, { labels: ["proposal", "idea"] });
      try { gh.send("DELETE", `repos/${repo}/issues/${it.resurface}/labels/later`); } catch { /* not labelled */ }
      gh.send("POST", `repos/${repo}/issues/${it.resurface}/comments`, { body: `Resurfaced in ${digestTitle(date)}.\n\n${ideaBody(it, date)}` });
    } else {
      issue = gh.send("POST", `repos/${repo}/issues`, { title: it.title, body: ideaBody(it, date), labels: ["proposal", "idea"] });
    }
    rows.push({ n: n++, ref: `${repo}#${issue.number}`, title: it.title, area: it.area, value: it.value, difficulty: it.difficulty, estimate: it.estimate, url: issue.html_url });
  }
  // Unanswered ideas from earlier digests, so nothing silently drops off the list.
  const listed = new Set(rows.map((r) => r.ref));
  for (const repo of ALL_REPOS) {
    for (const i of gh.list(`repos/${repo}/issues?state=open&labels=idea,proposal&sort=created&direction=asc`, 20)) {
      const ref = `${repo}#${i.number}`;
      if (i.pull_request || listed.has(ref) || rows.length >= 25) continue;
      const m = /\*\*Value\*\* [●○]+ \((\d)\/5\) · \*\*Difficulty\*\* ([SML]) · \*\*Estimate\*\* ([^·]+?) ·/.exec(i.body ?? "");
      rows.push({ n: n++, ref, title: i.title, area: repo === APP_REPO ? "app" : repo === API_REPO ? "api" : "web", value: Number(m?.[1] ?? 3), difficulty: m?.[2] ?? "M", estimate: m?.[3]?.trim() ?? "?", url: i.html_url, earlier: true });
    }
  }
  for (const old of existing.filter((i) => i.state === "open")) gh.send("PATCH", `repos/${APP_REPO}/issues/${old.number}`, { state: "closed", state_reason: "completed" });
  const digest = gh.send("POST", `repos/${APP_REPO}/issues`, { title: digestTitle(date), body: digestBody({ date, rows, waiting: waitingItems(gh) }), labels: ["digest"] });
  console.log(`posted ${digest.html_url} with ${rows.filter((r) => !r.earlier).length} new idea(s)`);
  return 0;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const gh = makeGh();
  const now = Date.now();
  if (cmd === "check") {
    const t = digestTitle(localDate(new Date(now)));
    const has = gh.list(`repos/${APP_REPO}/issues?state=all&labels=digest`, 50).some((i) => i.title === t);
    console.log(has ? `${t} already posted` : `${t} not posted yet`);
    return has ? 1 : 0;
  }
  if (cmd === "context") { console.log(context(gh, now)); return 0; }
  if (cmd === "post" && arg) return post(gh, arg, new Date(now));
  console.error("usage: ideas.mjs check | context | post <ideas.json>");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`ideas: ${e.message}`); process.exit(2); });
}
