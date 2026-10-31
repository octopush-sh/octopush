#!/usr/bin/env node
// Nightly review + guarded auto-merge for agent PRs in the app repo
// (VISION.md §8). The reviewer agent only judges; it posts its verdict through
// `review`, which signs it as the reviewer account. THIS script is the only
// thing that merges, and it re-checks every rule on the PR's head commit.
//
//   automerge.mjs check                         exit 0 if a builder PR with green CI awaits review
//   automerge.mjs queue                         those PRs: number<TAB>head-sha<TAB>title<TAB>url
//   automerge.mjs review <n> <sha> approve|changes <body-file>
//                                               post the review as the reviewer (refuses if the head moved)
//   automerge.mjs review-json <n> <sha> <file>  post a reviewer agent's verdict file
//                                               ({"verdict":"approve|changes","body":"…"}) after
//                                               validating it and scanning it for secrets
//   automerge.mjs merge <n>                     verify every rule, merge; exit 0 merged, 1 refused, 2 error
//
// Identities (owner / builder / reviewer) come from identity.mjs.
import { readFileSync } from "node:fs";
import { makeGh, ghRunAs, APP_REPO, ciStatus, labelsOf, sanitize, reportFatal } from "./gh.mjs";
import { loadIdentities, requireIdentities, reviewerToken, assertActingAs, sameLogin } from "./identity.mjs";

export const MAX_CHANGED_LINES = 800;
export const MAX_REVIEW_ROUNDS = 3;
const GITHUB_FILES_CAP = 3000;

/**
 * Paths an agent PR may never auto-merge (VISION.md §8 human-only areas, plus
 * anything that runs at install/build/CI time on the owner's machine).
 * Matched case-insensitively against both the new and the previous filename.
 */
export const HUMAN_ONLY = [
  /^\.github\//i,
  /^vision\.md$/i,
  // Agent instructions anywhere (a nested CLAUDE.md would brief every later agent).
  /(^|\/)(claude|agents)(\.local)?\.md$/i, /(^|\/)\.claude\//i,
  /(^|\/)\.gitattributes$/i, // can hide diffs from the reviewer (-diff, textconv)
  /^scripts\//i, // release, routines, deploy, clips, whats-new — all executed by CI or the Mac
  /^\.npmrc$/i, /^\.nvmrc$/i, /^\.husky\//i,
  /^package(-lock)?\.json$/i, /^npm-shrinkwrap\.json$/i, /^pnpm-lock\.yaml$/i, /^yarn\.lock$/i,
  /^vite\.config\.[cm]?[jt]s$/i, /^vitest\.config\.[cm]?[jt]s$/i, /^tsconfig[^/]*\.json$/i,
  /^src-tauri\/cargo\.(toml|lock)$/i, /^src-tauri\/build\.rs$/i, /^src-tauri\/\.cargo\//i,
  /^src-tauri\/tauri(\.[a-z]+)?\.conf\.json$/i, /^src-tauri\/capabilities\//i, /^src-tauri\/icons\//i,
  /^src-tauri\/src\/(billing|entitlement|auth|sync|settings|updater)\.rs$/i,
  /^src\/components\/settings\/(privacypane|accountpane)\.tsx$/i,
  /^src\/lib\/(entitlement|auth)[^/]*\.ts$/i,
  /^clips\.html$/i, /^index\.html$/i,
];

/** User-visible change heuristic: non-test code under src/ (frontend) or src-tauri/src/. */
const isTest = (n) => /\.test\.[cm]?[jt]sx?$/i.test(n) || /(^|\/)tests?\.rs$/i.test(n) || /(^|\/)tests?\//i.test(n);
const USER_VISIBLE = (n) => /^(src|src-tauri\/src)\//.test(n) && !isTest(n);
const CHANGESET = /^whats-new\/unreleased\/[a-z0-9-]+\.md$/;

export const marker = (sha, verdict) => `<!-- octopush-review:${sha}:${verdict} -->`;
const markerRe = (sha) => new RegExp(`<!-- octopush-review:${sha}:(approve|changes) -->`, "g");

/**
 * The latest review verdict on `sha` by the reviewer account, or null. Only a
 * marker that ends the comment counts — postReview always appends it last, so
 * a marker smuggled into other text (a file name in a refusal, say) never does.
 */
export function verdictFor(comments, sha, reviewer) {
  let v = null;
  for (const c of comments) {
    if (!sameLogin(c.user?.login, reviewer)) continue;
    const body = (c.body ?? "").trimEnd();
    const all = [...body.matchAll(markerRe(sha))];
    const last = all.at(-1);
    if (last && last.index + last[0].length === body.length) v = last[1];
  }
  return v;
}

/** How many times the reviewer has sent this PR back (any commit). */
export function reviewRounds(comments, reviewer) {
  return comments.filter((c) => sameLogin(c.user?.login, reviewer) && /<!-- octopush-review:\w+:changes -->/.test(c.body ?? "")).length;
}

/** Pure rule check. Returns a list of reasons the PR may NOT be merged. */
export function refusals({ pr, files, ci, verdict, ids, betaLive }) {
  const r = [];
  const labels = labelsOf(pr);
  if (!betaLive) r.push("the beta channel isn't live yet (no .github/workflows/promote.yml on main) — auto-merge would reach every user");
  if (pr.state !== "open") r.push("PR is not open");
  if (pr.draft) r.push("PR is a draft");
  if (!labels.includes("agent")) r.push("PR is not labelled `agent`");
  if (labels.includes("needs-owner")) r.push("PR is labelled `needs-owner`");
  if (!sameLogin(pr.user?.login, ids.builder)) r.push(`PR author ${pr.user?.login} is not the builder account`);
  if (pr.head?.repo?.full_name !== pr.base?.repo?.full_name) r.push("PR comes from a fork");
  if (pr.base?.ref !== "main") r.push(`PR targets ${pr.base?.ref}, not main`);
  if (ci !== "success") r.push(`CI is ${ci} on ${pr.head.sha.slice(0, 7)}`);
  if (verdict !== "approve") r.push(verdict === "changes" ? "the review requested changes" : `no approving review on ${pr.head.sha.slice(0, 7)}`);
  const changed = (pr.additions ?? 0) + (pr.deletions ?? 0);
  if (changed > MAX_CHANGED_LINES) r.push(`${changed} changed lines (max ${MAX_CHANGED_LINES})`);
  if (files.length >= GITHUB_FILES_CAP || (Number.isInteger(pr.changed_files) && files.length !== pr.changed_files)) {
    r.push(`file list incomplete (${files.length} of ${pr.changed_files} files) — can't verify paths`);
  }
  const paths = files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const blocked = [...new Set(paths.filter((n) => HUMAN_ONLY.some((re) => re.test(n))))];
  if (blocked.length) r.push(`touches human-only paths: ${blocked.join(", ")}`);
  const visible = files.some((f) => USER_VISIBLE(f.filename));
  const hasChangeset = files.some((f) => CHANGESET.test(f.filename) && f.status !== "removed");
  if (visible && !hasChangeset) r.push("user-visible change without a whats-new changeset");
  if (pr.mergeable === false) r.push("PR has merge conflicts");
  if (pr.mergeable == null) r.push("GitHub hasn't computed mergeability yet");
  return r;
}

/** Validate a reviewer agent's verdict file. Returns { verdict, body } or { error }. */
export function parseVerdict(text, secrets = []) {
  let v;
  try { v = JSON.parse(text); } catch { return { error: "verdict file is not valid JSON" }; }
  if (!v || !["approve", "changes"].includes(v.verdict)) return { error: 'verdict must be "approve" or "changes"' };
  if (typeof v.body !== "string" || v.body.trim().length < 20 || v.body.length > 20000) return { error: "body must be 20–20000 chars" };
  const s = secrets.map((x) => x.trim()).filter((x) => x.length >= 8);
  if (s.some((x) => v.body.includes(x))) return { error: "the review contains a secret value — not posted" };
  return { verdict: v.verdict, body: v.body };
}

/** "Not yet" reasons that shouldn't park a PR. */
const transient = (w) => /^CI is (pending|none)|^no approving review|^GitHub hasn't computed|^the beta channel isn't live/.test(w);

export function betaChannelLive(gh) {
  try { return !!gh.get(`repos/${APP_REPO}/contents/.github/workflows/promote.yml?ref=main`)?.sha; } catch { return false; }
}

export function reviewQueue(gh, ids) {
  const out = [];
  for (const p of gh.list(`repos/${APP_REPO}/pulls?state=open`)) {
    const l = labelsOf(p);
    if (!l.includes("agent") || l.includes("needs-owner") || l.includes("in-progress") || p.draft) continue;
    if (!sameLogin(p.user?.login, ids.builder) || p.head?.repo?.full_name !== APP_REPO) continue;
    if (ciStatus(gh, APP_REPO, p.head.sha) !== "success") continue;
    if (verdictFor(gh.list(`repos/${APP_REPO}/issues/${p.number}/comments`), p.head.sha, ids.reviewer)) continue;
    out.push(p);
  }
  return out;
}

export function postReview(gh, reviewerGh, ids, n, sha, verdict, body) {
  if (!["approve", "changes"].includes(verdict)) throw new Error("verdict must be approve|changes");
  const pr = gh.get(`repos/${APP_REPO}/pulls/${n}`);
  if (pr.head.sha !== sha) throw new Error(`head moved: reviewed ${sha.slice(0, 7)}, PR is now at ${pr.head.sha.slice(0, 7)} — review it again`);
  // With separate bot accounts the reviewer must not have opened the PR. In
  // Actions both are github-actions[bot]; independence comes from the agents
  // holding no token (identity.mjs).
  if (!sameLogin(ids.builder, ids.reviewer) && sameLogin(pr.user?.login, ids.reviewer)) throw new Error("the reviewer can't review its own PR");
  assertActingAs(reviewerGh, ids.reviewer, ids);
  reviewerGh.send("POST", `repos/${APP_REPO}/issues/${n}/comments`, { body: `${sanitize(body).trim()}\n\n${marker(sha, verdict)}` });
  if (verdict === "changes") {
    const rounds = reviewRounds(gh.list(`repos/${APP_REPO}/issues/${n}/comments`), ids.reviewer);
    if (rounds >= MAX_REVIEW_ROUNDS) {
      reviewerGh.send("POST", `repos/${APP_REPO}/issues/${n}/labels`, { labels: ["needs-owner"] });
      reviewerGh.send("POST", `repos/${APP_REPO}/issues/${n}/comments`, { body: `Sent back ${rounds} times — parking for the owner instead of another nightly round.\n\n<!-- octopush-automerge:${sha}:rounds -->` });
    }
  }
  return pr;
}

export function tryMerge(gh, actGh, n, ids) {
  const pr = gh.get(`repos/${APP_REPO}/pulls/${n}`);
  const files = gh.list(`repos/${APP_REPO}/pulls/${n}/files`, GITHUB_FILES_CAP);
  const comments = gh.list(`repos/${APP_REPO}/issues/${n}/comments`);
  const ci = ciStatus(gh, APP_REPO, pr.head.sha);
  const verdict = verdictFor(comments, pr.head.sha, ids.reviewer);
  const why = refusals({ pr, files, ci, verdict, ids, betaLive: betaChannelLive(gh) });
  if (why.length) {
    if (why.some((w) => !transient(w))) {
      actGh.send("POST", `repos/${APP_REPO}/issues/${n}/labels`, { labels: ["needs-owner"] });
      actGh.send("POST", `repos/${APP_REPO}/issues/${n}/comments`, {
        body: `Not auto-merged — needs the owner:\n\n${why.map((w) => `- ${sanitize(w)}`).join("\n")}\n\n<!-- octopush-automerge:${pr.head.sha}:refused -->`,
      });
    }
    return { merged: false, why };
  }
  const res = actGh.send("PUT", `repos/${APP_REPO}/pulls/${n}/merge`, { merge_method: "merge", sha: pr.head.sha });
  return { merged: !!res?.merged, why: res?.merged ? [] : [res?.message ?? "merge failed"] };
}

async function main() {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  const ids = requireIdentities(loadIdentities());
  const gh = makeGh(); // the builder's default login — used for reads
  const reviewerGh = () => makeGh(ghRunAs(reviewerToken()));
  if (cmd === "check" || cmd === "queue") {
    const q = reviewQueue(gh, ids);
    if (cmd === "queue") { for (const p of q) console.log(`${p.number}\t${p.head.sha}\t${p.title}\t${p.html_url}`); return 0; }
    if (!q.length) { console.log("no agent PRs awaiting review"); return 1; }
    console.log(`${q.length} agent PR(s) awaiting review: ${q.map((p) => `#${p.number}`).join(" ")}`);
    return 0;
  }
  if (cmd === "review") {
    if (!/^\d+$/.test(a ?? "") || !/^[0-9a-f]{40}$/.test(b ?? "") || !d) throw new Error("usage: review <n> <head-sha> approve|changes <body-file>");
    postReview(gh, reviewerGh(), ids, Number(a), b, c, readFileSync(d, "utf8"));
    console.log(`posted ${c} on #${a} at ${b.slice(0, 7)}`);
    return 0;
  }
  if (cmd === "review-json") {
    if (!/^\d+$/.test(a ?? "") || !/^[0-9a-f]{40}$/.test(b ?? "") || !c) throw new Error("usage: review-json <n> <head-sha> <file>");
    const v = parseVerdict(readFileSync(c, "utf8"), (process.env.OCTOPUSH_SECRETS ?? "").split("\n"));
    if (v.error) { console.error(`not posted #${a}: ${v.error}`); return 1; }
    postReview(gh, reviewerGh(), ids, Number(a), b, v.verdict, v.body);
    console.log(`posted ${v.verdict} on #${a} at ${b.slice(0, 7)}`);
    return 0;
  }
  if (cmd === "merge") {
    if (!/^\d+$/.test(a ?? "")) throw new Error("usage: merge <pr-number>");
    const r = tryMerge(gh, reviewerGh(), Number(a), ids);
    if (r.merged) { console.log(`merged #${a}`); return 0; }
    console.log(`not merged #${a}:\n${r.why.map((w) => `  - ${w}`).join("\n")}`);
    return 1;
  }
  console.error("usage: automerge.mjs check | queue | review <n> <sha> approve|changes <file> | merge <n>");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => { reportFatal("automerge", e); process.exit(2); });
}
