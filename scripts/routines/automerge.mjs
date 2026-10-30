#!/usr/bin/env node
// Nightly review + guarded auto-merge for agent PRs in the app repo
// (VISION.md §8). The review itself is done by an agent; THIS script is the
// only thing that merges, and it re-checks every rule on the PR's head commit.
//
//   automerge.mjs check          exit 0 if an agent PR with green CI awaits review
//   automerge.mjs queue          those PRs: number<TAB>head-sha<TAB>title<TAB>url
//   automerge.mjs merge <n>      verify all rules, then merge; exit 0 merged,
//                                1 refused (labels it needs-owner + comments why), 2 error
//   automerge.mjs marker <n> approve|changes   print the review marker to put in the review comment
//   automerge.mjs changes        agent PRs whose review asked for changes: number<TAB>branch<TAB>title<TAB>url
//
// Review markers: a comment by the owner's account containing
// `<!-- octopush-review:<head-sha>:approve -->` (or `:changes`). Comments by
// anyone else never count.
import { makeGh, APP_REPO, ciStatus, labelsOf } from "./gh.mjs";

export const MAX_CHANGED_LINES = 800;

/** Paths agents may never auto-merge (VISION.md §8 human-only areas). */
export const HUMAN_ONLY = [
  /^\.github\//,
  /^VISION\.md$/,
  /^CLAUDE\.md$/,
  /^AGENTS\.md$/,
  /^scripts\/release\.mjs$/,
  /^scripts\/routines\//,
  /^scripts\/deploy/,
  /^src-tauri\/tauri\.conf\.json$/,
  /^src-tauri\/src\/(billing|entitlement|auth|sync|settings)\.rs$/,
  /^src\/components\/settings\/(PrivacyPane|AccountPane)\.tsx$/,
  /^src\/lib\/(entitlement|auth)[^/]*\.ts$/,
];

/** User-visible change heuristic: non-test code under src/ (frontend) or src-tauri/src/. */
const USER_VISIBLE = /^(src|src-tauri\/src)\/(?!.*\.test\.)(?!.*\/tests?\.rs$)/;
const CHANGESET = /^whats-new\/unreleased\/[a-z0-9-]+\.md$/;

export const markerRe = (sha) => new RegExp(`<!-- octopush-review:${sha}:(approve|changes) -->`);
export const marker = (sha, verdict) => `<!-- octopush-review:${sha}:${verdict} -->`;

/** The latest review verdict on the PR's head commit by `viewer`, or null. */
export function verdictFor(comments, sha, viewer) {
  let v = null;
  for (const c of comments) {
    if (c.user?.login !== viewer) continue;
    const m = markerRe(sha).exec(c.body ?? "");
    if (m) v = m[1];
  }
  return v;
}

/** Pure rule check. Returns a list of reasons the PR may NOT be merged. */
export function refusals({ pr, files, ci, verdict, viewer }) {
  const r = [];
  const labels = labelsOf(pr);
  if (pr.state !== "open") r.push("PR is not open");
  if (pr.draft) r.push("PR is a draft");
  if (!labels.includes("agent")) r.push("PR is not labelled `agent`");
  if (labels.includes("needs-owner")) r.push("PR is labelled `needs-owner`");
  if (pr.user?.login !== viewer) r.push(`PR author ${pr.user?.login} is not the owner account`);
  if (ci !== "success") r.push(`CI is ${ci} on ${pr.head.sha.slice(0, 7)}`);
  if (verdict !== "approve") r.push(verdict === "changes" ? "the review requested changes" : `no approving review on ${pr.head.sha.slice(0, 7)}`);
  const changed = (pr.additions ?? 0) + (pr.deletions ?? 0);
  if (changed > MAX_CHANGED_LINES) r.push(`${changed} changed lines (max ${MAX_CHANGED_LINES})`);
  const names = files.map((f) => f.filename);
  const blocked = names.filter((n) => HUMAN_ONLY.some((re) => re.test(n)));
  if (blocked.length) r.push(`touches human-only paths: ${blocked.join(", ")}`);
  const visible = names.some((n) => USER_VISIBLE.test(n));
  const hasChangeset = files.some((f) => CHANGESET.test(f.filename) && f.status !== "removed");
  if (visible && !hasChangeset && !labels.includes("no-changeset")) r.push("user-visible change without a whats-new changeset (label `no-changeset` if it truly isn't)");
  if (pr.mergeable === false) r.push("PR has merge conflicts");
  return r;
}

export function reviewQueue(gh, viewer) {
  const prs = gh.list(`repos/${APP_REPO}/pulls?state=open`).filter((p) => labelsOf(p).includes("agent") && !p.draft && !labelsOf(p).includes("needs-owner"));
  const out = [];
  for (const p of prs) {
    if (ciStatus(gh, APP_REPO, p.head.sha) !== "success") continue;
    const comments = gh.list(`repos/${APP_REPO}/issues/${p.number}/comments`);
    if (verdictFor(comments, p.head.sha, viewer)) continue; // already reviewed at this commit
    out.push(p);
  }
  return out;
}

export function tryMerge(gh, n, viewer) {
  const pr = gh.get(`repos/${APP_REPO}/pulls/${n}`);
  const files = gh.list(`repos/${APP_REPO}/pulls/${n}/files`, 3000);
  const comments = gh.list(`repos/${APP_REPO}/issues/${n}/comments`);
  const ci = ciStatus(gh, APP_REPO, pr.head.sha);
  const verdict = verdictFor(comments, pr.head.sha, viewer);
  const why = refusals({ pr, files, ci, verdict, viewer });
  if (why.length) {
    // A pending CI or a missing review is "not yet", not a reason to park the PR.
    const parked = why.filter((w) => !/^CI is pending|^no approving review/.test(w));
    if (parked.length) {
      gh.send("POST", `repos/${APP_REPO}/issues/${n}/labels`, { labels: ["needs-owner"] });
      gh.send("POST", `repos/${APP_REPO}/issues/${n}/comments`, {
        body: `Not auto-merged — needs the owner:\n\n${why.map((w) => `- ${w}`).join("\n")}\n\n<!-- octopush-automerge:${pr.head.sha}:refused -->`,
      });
    }
    return { merged: false, why };
  }
  const res = gh.send("PUT", `repos/${APP_REPO}/pulls/${n}/merge`, { merge_method: "merge", sha: pr.head.sha });
  return { merged: !!res?.merged, why: res?.merged ? [] : [res?.message ?? "merge failed"] };
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const gh = makeGh();
  if (cmd === "marker") {
    const pr = gh.get(`repos/${APP_REPO}/pulls/${a}`);
    if (!["approve", "changes"].includes(b)) throw new Error("verdict must be approve|changes");
    console.log(marker(pr.head.sha, b));
    return 0;
  }
  const viewer = gh.viewer();
  if (cmd === "check") {
    const q = reviewQueue(gh, viewer);
    if (!q.length) { console.log("no agent PRs awaiting review"); return 1; }
    console.log(`${q.length} agent PR(s) awaiting review: ${q.map((p) => `#${p.number}`).join(" ")}`);
    return 0;
  }
  if (cmd === "changes") {
    // Agent PRs whose latest review on the head commit asked for changes: the
    // nightly builder addresses these before taking new issues.
    for (const p of gh.list(`repos/${APP_REPO}/pulls?state=open`)) {
      if (!labelsOf(p).includes("agent") || labelsOf(p).includes("needs-owner")) continue;
      const v = verdictFor(gh.list(`repos/${APP_REPO}/issues/${p.number}/comments`), p.head.sha, viewer);
      if (v === "changes") console.log(`${p.number}\t${p.head.ref}\t${p.title}\t${p.html_url}`);
    }
    return 0;
  }
  if (cmd === "queue") {
    for (const p of reviewQueue(gh, viewer)) console.log(`${p.number}\t${p.head.sha}\t${p.title}\t${p.html_url}`);
    return 0;
  }
  if (cmd === "merge") {
    if (!/^\d+$/.test(a ?? "")) throw new Error("usage: merge <pr-number>");
    const r = tryMerge(gh, Number(a), viewer);
    if (r.merged) { console.log(`merged #${a}`); return 0; }
    console.log(`not merged #${a}:\n${r.why.map((w) => `  - ${w}`).join("\n")}`);
    return 1;
  }
  console.error("usage: automerge.mjs check | queue | merge <n> | marker <n> approve|changes");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => { console.error(`automerge: ${e.message}`); process.exit(2); });
}
