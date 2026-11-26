#!/usr/bin/env node
// Job picker for the nightly builders (docs/ROUTINES.md §2).
//
//   jobs.mjs check                 exit 0 when there is a job (read-only, fast)
//   jobs.mjs next                  print the next job, fixes first:
//                                    pr<TAB>number<TAB>branch<TAB>title<TAB>url   (review sent back, red CI,
//                                                                                  or conflicts with main)
//                                    issue<TAB>number<TAB>title<TAB>url           (a `ready` issue)
//                                  In the app repo, while main's CI is red, it first opens or updates
//                                  the cycle's one "main is red" issue and offers it before anything
//                                  else; red-CI fix rounds wait (main is the likelier cause). Once main
//                                  is green, that issue is closed (main-health.mjs).
//   jobs.mjs claim issue|pr <n>    label it `in-progress` (claims expire after 24 h)
//   jobs.mjs release issue|pr <n>  remove the claim
//
//   jobs.mjs --repo octopush-sh/octopush-web next|claim|release …   the web builder (web-build.yml):
//                                  fixes on web PRs first, then the oldest `ready` web issue, then the
//                                  oldest app-repo issue labelled `area:web` + `ready`:
//                                    app-issue<TAB>number<TAB>title<TAB>url
//                                  (claim/release app-issue <n> label it in the app repo)
//
//   jobs.mjs --repo octopush-sh/epiku next|claim|release …          the Epiku builder (epiku-build.yml):
//                                  the plain queue above, in that private repo, with the App's token
//                                  (OCTOPUSH_EPIKU_TOKEN); `next` prints no title or URL.
//
// Only builder-authored, same-repo PRs labelled `agent` count — as jobs and as
// claims on issues — so an outsider's PR can neither steal nor block work.
import { execFileSync } from "node:child_process";
import { makeGh, ghForRepo, APP_REPO, WEB_REPO, isPrivateLane, markPrivate, ciStatus, labelsOf, reportFatal } from "./gh.mjs";
import { loadIdentities, requireIdentities, assertActingAs, sameLogin, idsForRepo } from "./identity.mjs";
import { verdictFor, reviewRounds, MAX_REVIEW_ROUNDS } from "./automerge.mjs";
import { mainCi, findMainRedIssue, syncMainRed, takeable } from "./main-health.mjs";

export const CLAIM_TTL_MS = 24 * 3600e3;
export const RED_CI_MAX_AGE_MS = 7 * 24 * 3600e3;
/** Fix rounds the builder may spend on one PR before it's parked for the owner. */
export const MAX_FIX_ROUNDS = 3;
const UPDATE_MARK = "<!-- octopush-build:update -->";
const PARKED = ["needs-owner", "proposal", "later"];
/** Ideas for the website/API live here too (area:web|api) but this repo's builder can't build them. */
const OTHER_AREA = ["area:web", "area:api"]; // skipped here, unless area:app + area:web (app work)
const APP_AREA = "area:app";
/** App-repo issues the web builder takes (VISION.md §8: website work queued in the hub). */
export const WEB_AREA = "area:web";

export const closingRefs = (text) =>
  [...(text ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)].map((m) => Number(m[1]));
/** `Closes octopush-sh/octopush#N` — how a web PR built for an app-repo issue names it (publish-build.mjs). */
export const appRefs = (text) =>
  [...(text ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+octopush-sh\/octopush#(\d+)\b/gi)].map((m) => Number(m[1]));

/** When the `in-progress` label was last added, or null. */
function claimedAt(gh, repo, n) {
  const ev = gh.list(`repos/${repo}/issues/${n}/events`, 300).filter((e) => e.event === "labeled" && e.label?.name === "in-progress");
  return ev.length ? Date.parse(ev.at(-1).created_at) : null;
}

export function isFreshClaim(gh, repo, item, now) {
  if (!labelsOf(item).includes("in-progress")) return false;
  const at = claimedAt(gh, repo, item.number);
  return at !== null && now - at < CLAIM_TTL_MS;
}

export function builderPrs(gh, repo, ids) {
  return gh.list(`repos/${repo}/pulls?state=open`).filter((p) =>
    labelsOf(p).includes("agent") && sameLogin(p.user?.login, ids.builder) && p.head?.repo?.full_name === repo && p.base?.ref === "main");
}

/**
 * Builder PRs that need another pass: the reviewer sent them back, CI is red,
 * or (app repo) the PR conflicts with main — nightly-build.yml merges main into
 * the branch and leaves the conflicts for the agent to resolve. All three count
 * against the same MAX_FIX_ROUNDS.
 */
export function fixJobs(gh, repo, ids, now) {
  const out = [];
  for (const p of builderPrs(gh, repo, ids)) {
    if (labelsOf(p).includes("needs-owner") || isFreshClaim(gh, repo, p, now)) continue;
    const comments = gh.list(`repos/${repo}/issues/${p.number}/comments`);
    if (reviewRounds(comments, ids.reviewer) >= MAX_REVIEW_ROUNDS) continue; // the reviewer parks these
    const sentBack = verdictFor(comments, p.head.sha, ids.reviewer) === "changes";
    const red = ciStatus(gh, repo, p.head.sha) === "failure";
    const rounds = comments.filter((c) => sameLogin(c.user?.login, ids.builder) && (c.body ?? "").trimEnd().endsWith(UPDATE_MARK)).length;
    // Only the app's builder workflow merges main before a fix round; the other lanes don't.
    let conflicts = false;
    if (!sentBack && !red && repo === APP_REPO) { try { conflicts = gh.get(`repos/${repo}/pulls/${p.number}`)?.mergeable === false; } catch { conflicts = false; } }
    if (sentBack || red || conflicts) {
      out.push({ pr: p, reason: sentBack ? "changes" : red ? "red-ci" : "conflicts", stale: rounds >= MAX_FIX_ROUNDS || (red && now - Date.parse(p.created_at) > RED_CI_MAX_AGE_MS) });
    }
  }
  return out;
}

/**
 * Main's health for the app builder: `{ health, issue }`. With `write`, the
 * "main is red" issue is opened, updated or closed to match (syncMainRed);
 * without, it is only looked up. Never fatal: if main can't be read, the queue
 * runs as before.
 */
export function mainState(gh, repo, ids, { write = false } = {}) {
  if (repo !== APP_REPO) return { health: null, issue: null };
  try {
    const health = mainCi(gh, repo);
    if (!write) return { health, issue: findMainRedIssue(gh, repo, ids) };
    const { issue, opened = false } = syncMainRed(gh, repo, ids, health);
    return { health, issue, opened };
  } catch (e) {
    console.error(`jobs: main's CI unreadable (${String(e?.message ?? e).split("\n")[0].slice(0, 200)}) — queue as usual`);
    return { health: null, issue: null };
  }
}

/**
 * The jobs in order, for `check` and `next` (app repo): while main is red,
 * its issue first (if the builder may take it) and no red-CI rounds except on
 * the PR that fixes main; then fixes; then `ready` issues.
 */
export function orderedJobs(gh, repo, ids, now, { health, issue, opened = false }) {
  const red = health?.state === "red";
  const issues = issueJobs(gh, repo, ids, now);
  const fixesMain = (p) => !!issue && closingRefs(`${p.title}\n${p.body}`).includes(issue.number);
  const fixes = fixJobs(gh, repo, ids, now).filter((j) => !red || j.reason !== "red-ci" || fixesMain(j.pr));
  // Just opened: nobody can have claimed it yet, even if the list hasn't caught up.
  const top = red && takeable(issue) ? issues.find((i) => i.number === issue.number) ?? (opened ? issue : null) : null;
  return { top, fixes, issues: top ? issues.filter((i) => i.number !== top.number) : issues };
}

export function issueJobs(gh, repo, ids, now) {
  const claimed = new Set(builderPrs(gh, repo, ids).flatMap((p) => closingRefs(`${p.title}\n${p.body}`)));
  // In the app repo, website/API work waits for its own builder; in the web repo every issue is web work.
  const skip = repo === APP_REPO ? OTHER_AREA : [];
  return gh.list(`repos/${repo}/issues?labels=ready&state=open&sort=created&direction=asc`)
    // An issue labelled area:app is app work even if it also touches the site
    // (#298 and #300 carried area:web too and the builder skipped them).
    .filter((i) => !i.pull_request && !labelsOf(i).some((l) => PARKED.includes(l)) && !claimed.has(i.number))
    // ...but area:api still waits: nothing builds the API half, and shipping UI for a
    // missing endpoint is worse than waiting.
    .filter((i) => !labelsOf(i).some((l) => skip.includes(l) && (l !== WEB_AREA || !labelsOf(i).includes(APP_AREA))))
    .filter((i) => !isFreshClaim(gh, repo, i, now));
}

/**
 * App-repo issues for the web builder: `area:web` + `ready`, not parked, not
 * claimed (a fresh `in-progress`, or an open web builder PR that references
 * `octopush-sh/octopush#N`). `appGh` reads the app repo, `webGh` the web repo;
 * `webIds` are the web repo's identities (its builder is the App's bot).
 */
export const MERGED_CLAIM_MS = 14 * 24 * 3600e3;
export function appWebIssueJobs(appGh, webGh, webIds, now) {
  const claimed = new Set(builderPrs(webGh, WEB_REPO, webIds).flatMap((p) => appRefs(`${p.title}\n${p.body}`)));
  // Done already: a web builder PR merged in the last two weeks names it. (The
  // App's bot can't close app-repo issues through a closing keyword; answers.mjs
  // closes them on `merge web#N`, and this keeps one that slipped through from
  // being rebuilt every two hours.)
  for (const p of webGh.list(`repos/${WEB_REPO}/pulls?state=closed&sort=updated&direction=desc`, 100)) {
    if (!p.merged_at || now - Date.parse(p.merged_at) > MERGED_CLAIM_MS) continue;
    if (!sameLogin(p.user?.login, webIds.builder) || p.head?.repo?.full_name !== WEB_REPO || p.base?.ref !== "main") continue;
    for (const n of appRefs(`${p.title}\n${p.body}`)) claimed.add(n);
  }
  return appGh.list(`repos/${APP_REPO}/issues?labels=ready,${WEB_AREA}&state=open&sort=created&direction=asc`)
    // area:app + area:web is app work (the app builder takes it), never both builders.
    .filter((i) => !i.pull_request && labelsOf(i).includes(WEB_AREA) && !labelsOf(i).includes(APP_AREA) && !labelsOf(i).some((l) => PARKED.includes(l)) && !claimed.has(i.number))
    .filter((i) => !isFreshClaim(appGh, APP_REPO, i, now));
}

/**
 * The line `next` prints for a job. For a private lane (epiku) it stops at the
 * number and the branch: a title or URL of that repo must never be one `cat`
 * away from this public repo's log.
 */
export function jobLine(j, repo) {
  const head = j.kind === "pr" ? [j.kind, j.n, j.branch] : [j.kind, j.n];
  return (isPrivateLane(repo) ? head : [...head, j.title, j.url]).join("\t");
}

function thisRepo() {
  if (process.env.OCTOPUSH_ROUTINE_REPO) return process.env.OCTOPUSH_ROUTINE_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim().replace(/\.git$/, "");
  return url.replace(/^.*[:/]([^/:]+\/[^/]+)$/, "$1");
}

async function main() {
  let argv = process.argv.slice(2);
  let repo = null;
  if (argv[0] === "--repo") { repo = argv[1]; argv = argv.slice(2); }
  repo ??= thisRepo();
  markPrivate(repo);
  const [cmd, kind, num] = argv;
  const baseIds = requireIdentities(loadIdentities());
  const ids = idsForRepo(baseIds, repo);
  const gh = ghForRepo(repo);
  const now = Date.now();
  if (repo === WEB_REPO) return webMain({ cmd, kind, num, gh, ids, baseIds, now });
  if (cmd === "check") {
    const state = mainState(gh, repo, ids);
    // Red with no issue yet: `next` opens it, so that is work.
    if (state.health?.state === "red" && !state.issue) { console.log("work: main is red (its issue is opened by the next build)"); return 0; }
    const { top, fixes, issues } = orderedJobs(gh, repo, ids, now, state);
    if (top) { console.log(`work: issue #${top.number} (main is red)`); return 0; }
    const f = fixes.filter((j) => !j.stale);
    if (f.length) { console.log(`work: pr #${f[0].pr.number} (${f[0].reason})`); return 0; }
    if (issues.length) { console.log(`work: issue #${issues[0].number}`); return 0; }
    console.log(`no review fixes and no unclaimed ready issues in ${repo}`);
    return 1;
  }
  assertActingAs(gh, ids.builder, ids);
  if (cmd === "next") {
    const { top, fixes, issues } = orderedJobs(gh, repo, ids, now, mainState(gh, repo, ids, { write: true }));
    if (top) { console.log(jobLine({ kind: "issue", n: top.number, title: top.title, url: top.html_url }, repo)); return 0; }
    for (const j of fixes) {
      if (j.stale) {
        gh.send("POST", `repos/${repo}/issues/${j.pr.number}/labels`, { labels: ["needs-owner"] });
        gh.send("POST", `repos/${repo}/issues/${j.pr.number}/comments`, { body: `Still failing after ${MAX_FIX_ROUNDS} fix rounds or a week of red CI — parking for the owner.\n\n<!-- octopush-jobs:stale -->` });
        continue;
      }
      console.log(jobLine({ kind: "pr", n: j.pr.number, branch: j.pr.head.ref, title: j.pr.title, url: j.pr.html_url }, repo));
      return 0;
    }
    const [i] = issues;
    if (i) { console.log(jobLine({ kind: "issue", n: i.number, title: i.title, url: i.html_url }, repo)); return 0; }
    console.error(`nothing to do in ${repo}`);
    return 1;
  }
  if ((cmd === "claim" || cmd === "release") && ["issue", "pr"].includes(kind) && /^\d+$/.test(num ?? "")) {
    if (cmd === "claim") gh.send("POST", `repos/${repo}/issues/${num}/labels`, { labels: ["in-progress"] });
    else { try { gh.send("DELETE", `repos/${repo}/issues/${num}/labels/in-progress`); } catch { /* not claimed */ } }
    console.log(`${cmd}ed ${kind} #${num}`);
    return 0;
  }
  console.error("usage: jobs.mjs check | next | claim issue|pr <n> | release issue|pr <n>");
  return 64;
}

/** The web builder's queue: web PR fixes, web `ready` issues, then app-repo `area:web` issues. */
export function nextWebJob(webGh, appGh, ids, now) {
  for (const j of fixJobs(webGh, WEB_REPO, ids, now)) {
    if (j.stale) {
      webGh.send("POST", `repos/${WEB_REPO}/issues/${j.pr.number}/labels`, { labels: ["needs-owner"] });
      webGh.send("POST", `repos/${WEB_REPO}/issues/${j.pr.number}/comments`, { body: `Still failing after ${MAX_FIX_ROUNDS} fix rounds or a week of red CI — parking for the owner.\n\n<!-- octopush-jobs:stale -->` });
      continue;
    }
    return { kind: "pr", n: j.pr.number, branch: j.pr.head.ref, title: j.pr.title, url: j.pr.html_url };
  }
  const [i] = issueJobs(webGh, WEB_REPO, ids, now);
  if (i) return { kind: "issue", n: i.number, title: i.title, url: i.html_url };
  const [a] = appWebIssueJobs(appGh, webGh, ids, now);
  if (a) return { kind: "app-issue", n: a.number, title: a.title, url: a.html_url };
  return null;
}

function webMain({ cmd, kind, num, gh, ids, now }) {
  const appGh = makeGh(); // GH_TOKEN: the app repo (area:web issues live there)
  if (cmd === "next") {
    assertActingAs(gh, ids.builder, ids);
    const j = nextWebJob(gh, appGh, ids, now);
    if (!j) { console.error(`nothing to do for ${WEB_REPO}`); return 1; }
    console.log(j.kind === "pr" ? `pr\t${j.n}\t${j.branch}\t${j.title}\t${j.url}` : `${j.kind}\t${j.n}\t${j.title}\t${j.url}`);
    return 0;
  }
  if ((cmd === "claim" || cmd === "release") && ["issue", "pr", "app-issue"].includes(kind) && /^\d+$/.test(num ?? "")) {
    const [g, r] = kind === "app-issue" ? [appGh, APP_REPO] : [gh, WEB_REPO];
    if (cmd === "claim") g.send("POST", `repos/${r}/issues/${num}/labels`, { labels: ["in-progress"] });
    else { try { g.send("DELETE", `repos/${r}/issues/${num}/labels/in-progress`); } catch { /* not claimed */ } }
    console.log(`${cmd}ed ${kind} #${num}`);
    return 0;
  }
  console.error(`usage: jobs.mjs --repo ${WEB_REPO} next | claim|release issue|pr|app-issue <n>`);
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { reportFatal("jobs", e); process.exit(2); });
}
