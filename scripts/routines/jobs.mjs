#!/usr/bin/env node
// Job picker for the nightly builders (docs/ROUTINES.md §2).
//
//   jobs.mjs check                 exit 0 when there is a job (read-only, fast)
//   jobs.mjs next                  print the next job, fixes first:
//                                    pr<TAB>number<TAB>branch<TAB>title<TAB>url   (review sent back, or red CI)
//                                    issue<TAB>number<TAB>title<TAB>url           (a `ready` issue)
//   jobs.mjs claim issue|pr <n>    label it `in-progress` (claims expire after 24 h)
//   jobs.mjs release issue|pr <n>  remove the claim
//
// Only builder-authored, same-repo PRs labelled `agent` count — as jobs and as
// claims on issues — so an outsider's PR can neither steal nor block work.
import { execFileSync } from "node:child_process";
import { makeGh, APP_REPO, ciStatus, labelsOf } from "./gh.mjs";
import { loadIdentities, requireIdentities, assertActingAs, sameLogin } from "./identity.mjs";
import { verdictFor, reviewRounds, MAX_REVIEW_ROUNDS } from "./automerge.mjs";

export const CLAIM_TTL_MS = 24 * 3600e3;
export const RED_CI_MAX_AGE_MS = 7 * 24 * 3600e3;
const PARKED = ["needs-owner", "proposal", "later"];

export const closingRefs = (text) =>
  [...(text ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/gi)].map((m) => Number(m[1]));

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

/** Builder PRs that need another pass: the reviewer sent them back, or CI is red. */
export function fixJobs(gh, repo, ids, now) {
  if (repo !== APP_REPO) return [];
  const out = [];
  for (const p of builderPrs(gh, repo, ids)) {
    if (labelsOf(p).includes("needs-owner") || isFreshClaim(gh, repo, p, now)) continue;
    const comments = gh.list(`repos/${repo}/issues/${p.number}/comments`);
    if (reviewRounds(comments, ids.reviewer) >= MAX_REVIEW_ROUNDS) continue; // the reviewer parks these
    const sentBack = verdictFor(comments, p.head.sha, ids.reviewer) === "changes";
    const red = ciStatus(gh, repo, p.head.sha) === "failure";
    if (sentBack || red) out.push({ pr: p, reason: sentBack ? "changes" : "red-ci", stale: red && now - Date.parse(p.created_at) > RED_CI_MAX_AGE_MS });
  }
  return out;
}

export function issueJobs(gh, repo, ids, now) {
  const claimed = new Set(builderPrs(gh, repo, ids).flatMap((p) => closingRefs(`${p.title}\n${p.body}`)));
  return gh.list(`repos/${repo}/issues?labels=ready&state=open&sort=created&direction=asc`)
    .filter((i) => !i.pull_request && !labelsOf(i).some((l) => PARKED.includes(l)) && !claimed.has(i.number))
    .filter((i) => !isFreshClaim(gh, repo, i, now));
}

function thisRepo() {
  if (process.env.OCTOPUSH_ROUTINE_REPO) return process.env.OCTOPUSH_ROUTINE_REPO;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim().replace(/\.git$/, "");
  return url.replace(/^.*[:/]([^/:]+\/[^/]+)$/, "$1");
}

async function main() {
  const [cmd, kind, num] = process.argv.slice(2);
  const ids = requireIdentities(loadIdentities());
  const gh = makeGh();
  const repo = thisRepo();
  const now = Date.now();
  if (cmd === "check") {
    const f = fixJobs(gh, repo, ids, now).filter((j) => !j.stale);
    if (f.length) { console.log(`work: pr #${f[0].pr.number} (${f[0].reason})`); return 0; }
    const i = issueJobs(gh, repo, ids, now);
    if (i.length) { console.log(`work: issue #${i[0].number}`); return 0; }
    console.log(`no review fixes and no unclaimed ready issues in ${repo}`);
    return 1;
  }
  assertActingAs(gh, ids.builder, ids);
  if (cmd === "next") {
    for (const j of fixJobs(gh, repo, ids, now)) {
      if (j.stale) {
        gh.send("POST", `repos/${repo}/issues/${j.pr.number}/labels`, { labels: ["needs-owner"] });
        gh.send("POST", `repos/${repo}/issues/${j.pr.number}/comments`, { body: "CI has been red for over a week — parking for the owner.\n\n<!-- octopush-jobs:stale -->" });
        continue;
      }
      console.log(`pr\t${j.pr.number}\t${j.pr.head.ref}\t${j.pr.title}\t${j.pr.html_url}`);
      return 0;
    }
    const [i] = issueJobs(gh, repo, ids, now);
    if (i) { console.log(`issue\t${i.number}\t${i.title}\t${i.html_url}`); return 0; }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`jobs: ${e.message}`); process.exit(2); });
}
