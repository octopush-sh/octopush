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
//   automerge.mjs approved                      builder PRs already approved on their head (merge retries)
//   automerge.mjs merge <n>                     verify every rule, merge; exit 0 merged, 1 refused, 2 error
//
//   --repo octopush-sh/octopush-web (before the command) runs queue / review-json for the
//   website's agent PRs (web-review.yml). Website PRs never auto-merge (VISION.md §8): there is
//   no `merge` for them here — the owner answers `merge web#N` in the digest (answers.mjs).
//
//   --repo octopush-sh/epiku runs queue / review-json / approved / merge <n> [--dry-run] for
//   Epiku's agent PRs (epiku-review.yml). Epiku PRs DO auto-merge (Epiku's VISION.md §2), under
//   `epikuRefusals` below; everything else is parked for the owner. Epiku is private and this
//   repo is public, so for it these commands print numbers, commit ids and reason codes only.
//
// Identities (owner / builder / reviewer) come from identity.mjs.
import { readFileSync } from "node:fs";
import { makeGh, ghRunAs, ghForRepo, APP_REPO, WEB_REPO, EPIKU_REPO, tokenEnvFor, ciStatus, labelsOf, sanitize, reportFatal } from "./gh.mjs";
import { loadIdentities, requireIdentities, reviewerToken, assertActingAs, sameLogin, idsForRepo } from "./identity.mjs";

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

/**
 * octopush-web's human-only paths (its CLAUDE.md "Human-only areas"), plus the
 * same agent-instruction, git-attribute and dependency guards as the app. An
 * agent's web PR may not touch them (publish-build.mjs), and `merge web#N`
 * refuses a PR that does — the owner merges those on GitHub after reading them.
 */
export const WEB_HUMAN_ONLY = [
  /^\.github\//i,
  /(^|\/)(claude|agents)(\.local)?\.md$/i, /(^|\/)\.claude\//i,
  /(^|\/)\.gitattributes$/i,
  /^\.npmrc$/i, /^\.nvmrc$/i,
  /^package(-lock)?\.json$/i, /^npm-shrinkwrap\.json$/i, /^pnpm-lock\.yaml$/i, /^yarn\.lock$/i, /^tsconfig[^/]*\.json$/i,
  // Legal pages (any format: .astro, .md, .mdx, .html, or a folder).
  /^src\/pages\/(terms|privacy|refunds)(\.|\/)/i, /^src\/layouts\/legallayout\.astro$/i, /^src\/legal-config\.ts$/i,
  // Prices and the Free/Pro boundary (release.ts holds the prices and the version).
  /^src\/data\/release\.ts$/i, /^src\/content\/docs\/docs\/free-vs-pro\.mdx?$/i,
  // Privacy copy and analytics (astro.config.mjs carries the analytics snippet).
  /^src\/components\/analytics\.astro$/i, /^astro\.config\.[cm]?[jt]s$/i,
  // Deploy, the /download edge function, updater redirects, the truth gate and build scripts.
  /^scripts\//i, /^vercel\.json$/i, /^api\//i, /^\.vercel\//i, /^\.vercelignore$/i,
  // A real file wins over a vercel.json rewrite/redirect: a page or static file at
  // /download, /api or /update would shadow the download path or the updater feeds.
  /^src\/pages\/(download|api|update)(\.|\/)/i, /^public\/(download|api|update)(\.|\/|$)/i,
  // A root dynamic route ([slug].astro, [...path].astro) can generate any of them.
  /^src\/pages\/\[/i,
  // Content collections config (drafts, what gets published).
  /^src\/content\.config\.[cm]?[jt]s$/i,
];
/**
 * Epiku's human-only paths (its VISION.md §2 "Human-only areas"), plus the same
 * agent-instruction and git-attribute guards as the other repos. An agent's
 * Epiku PR may not touch them (publish-build.mjs) and the merge refuses one
 * that does. `package.json` is refused whole: VISION.md lets an agent edit its
 * `scripts` block but not its dependencies, and a path rule can't tell the two
 * apart, so the stricter reading applies. What no path rule can see is left to
 * the reviewer's brief and to `epikuRefusals`: `useToken` inside `lib/store.ts`,
 * and code that reads an environment variable.
 */
export const EPIKU_HUMAN_ONLY = [
  /^\.github\//i,
  /^vision\.md$/i,
  /(^|\/)(claude|agents)(\.local)?\.md$/i, /(^|\/)\.claude\//i, /(^|\/)\.agents\//i, /^skills-lock\.json$/i,
  /(^|\/)\.gitattributes$/i,
  // Real project plans: read-only for agents, and nothing of theirs may be copied anywhere.
  /^data(\/|$)/i,
  // Authentication and tokens.
  /^lib\/(identidad|auth|api)\.[cm]?[jt]sx?$/i, /^scripts\/tokens\.py$/i,
  // Deploy and environment configuration.
  /^next\.config\.[cm]?[jt]s$/i, /^vercel\.json$/i, /^\.vercel(\/|$)/i, /^\.vercelignore$/i,
  /^\.npmrc$/i, /^\.nvmrc$/i, /(^|\/)\.env[^/]*$/i,
  // Dependencies.
  /^package(-lock)?\.json$/i, /^npm-shrinkwrap\.json$/i, /^pnpm-lock\.yaml$/i, /^yarn\.lock$/i,
];
/**
 * Epiku's two guard tests (every route checks permissions; backups restore).
 * An agent may change them, saying why, but such a PR is never auto-merged:
 * loosening one is how tenant isolation or the restore path would break quietly.
 */
export const EPIKU_GUARD_TESTS = [/^tests\/rutas\.test\.[cm]?[jt]sx?$/i, /^tests\/backup-roundtrip\.test\.[cm]?[jt]sx?$/i];
/** Human-only paths per repo. */
export const humanOnlyFor = (repo) => (repo === WEB_REPO ? WEB_HUMAN_ONLY : repo === EPIKU_REPO ? EPIKU_HUMAN_ONLY : HUMAN_ONLY);

/**
 * Why `merge web#N` must NOT merge a website PR (pure). The owner's answer is
 * the OK; these re-check that it is still the PR the review approved: opened by
 * the cycle's App from a branch of the web repo into main, labelled `agent`, CI
 * green and an approving review on the exact head commit, no human-only path,
 * the full file list, no conflicts.
 */
export function webMergeRefusals({ pr, files, ci, verdict, ids }) {
  const r = [];
  const labels = labelsOf(pr);
  if (pr.state !== "open") r.push("not open");
  if (pr.draft) r.push("a draft");
  if (!labels.includes("agent")) r.push("not labelled `agent`");
  if (labels.includes("needs-owner")) r.push("labelled `needs-owner` — read it and merge it on GitHub yourself");
  if (labels.includes("in-progress")) r.push("the web builder is working on it (`in-progress`) — answer again after its next push is reviewed");
  if (!sameLogin(pr.user?.login, ids.builder)) r.push("not opened by the web builder");
  if (pr.head?.repo?.full_name !== WEB_REPO || pr.base?.ref !== "main") r.push("must be a same-repo PR into main");
  if (ci !== "success") r.push(`CI is ${ci}`);
  if (verdict !== "approve") r.push(verdict === "changes" ? "the review asked for changes" : `no approving review on ${String(pr.head?.sha).slice(0, 7)}`);
  if (files.length >= GITHUB_FILES_CAP || (Number.isInteger(pr.changed_files) && files.length !== pr.changed_files)) r.push("file list incomplete");
  const blocked = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)).filter((n) => WEB_HUMAN_ONLY.some((re) => re.test(n))))];
  if (blocked.length) r.push(`touches human-only paths (${blocked.join(", ")}) — read it and merge it on GitHub yourself`);
  if (pr.mergeable === false) r.push("has merge conflicts");
  if (pr.mergeable == null) r.push("GitHub hasn't computed mergeability yet — answer again in a minute");
  return r;
}

/**
 * How the Epiku reviewer classifies a PR's effect on stored data and on the API
 * contract (Epiku's VISION.md §2, docs/DATA-SAFETY.md §3): `none`, `additive`
 * (backward-compatible: auto-mergeable) or `breaking` (the owner merges).
 * postReview signs it into the verdict comment, right before the verdict
 * marker, for the same commit; agent text can't carry either (sanitize).
 */
export const DATA_CLASSES = ["none", "additive", "breaking"];
export const dataMarker = (sha, cls) => `<!-- octopush-data:${sha}:${cls} -->`;
/** The class signed into the reviewer's latest verdict comment on `sha`, or null. */
export function dataClassFor(comments, sha, reviewer) {
  const tail = new RegExp(`<!-- octopush-data:${sha}:(none|additive|breaking) -->\\n<!-- octopush-review:${sha}:(?:approve|changes) -->$`);
  let cls = null;
  for (const c of comments) {
    if (!sameLogin(c.user?.login, reviewer)) continue;
    const body = (c.body ?? "").trimEnd();
    if (!new RegExp(`<!-- octopush-review:${sha}:(?:approve|changes) -->$`).test(body)) continue;
    cls = tail.exec(body)?.[1] ?? null; // a later verdict without a class clears an earlier one
  }
  return cls;
}

/** Added lines that read an environment variable or a secret (human-only in Epiku, whatever the file). */
const ENV_READ = /process\s*\.\s*env|import\.meta\.env|os\.environ|getenv\s*\(|loadEnvConfig|dotenv/i;
const addedLines = (patch) => String(patch).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
const isDoc = (n) => /\.mdx?$/i.test(n);
const EPIKU_ISSUE_PARKED = ["needs-owner", "proposal", "later"];

/**
 * Why an Epiku agent PR must NOT be auto-merged (pure). Each reason is
 * `{ code, text, transient? }`: the code is all that reaches this public
 * repo's log, the text goes into the comment on the private PR. Mirrors the
 * six auto-merge conditions of Epiku's VISION.md §2, the app lane's size cap,
 * and the checks a script can make for what those conditions leave to judgement:
 *   - `issue` is the issue the PR body closes (`Closes #n` on its first line), or null;
 *   - `dataClass` is the reviewer's signed classification for the head commit.
 * A `transient` reason means "not yet" and never parks the PR.
 */
export function epikuRefusals({ pr, files, ci, verdict, dataClass, issue, ids }) {
  const r = [];
  const no = (code, text, transient = false) => r.push(transient ? { code, text, transient } : { code, text });
  const labels = labelsOf(pr);
  const sha7 = String(pr.head?.sha).slice(0, 7);
  if (pr.state !== "open") no("closed", "the PR is not open");
  if (pr.draft) no("draft", "the PR is a draft");
  if (!labels.includes("agent")) no("label", "the PR is not labelled `agent`");
  if (labels.includes("needs-owner")) no("needs-owner", "the PR is labelled `needs-owner`");
  if (labels.includes("in-progress")) no("in-progress", "the builder is working on it (`in-progress`)", true);
  if (!sameLogin(pr.user?.login, ids.builder)) no("author", "the PR was not opened by the cycle's builder");
  if (pr.head?.repo?.full_name !== EPIKU_REPO || pr.base?.repo?.full_name !== EPIKU_REPO || pr.base?.ref !== "main") no("branch", "it must be a PR from a branch of this repo into main");
  if (ci !== "success") no("ci", `CI is ${ci} on ${sha7}`, ci === "pending" || ci === "none");
  if (verdict !== "approve") no("review", verdict === "changes" ? "the review requested changes" : `no approving review on ${sha7}`, verdict == null);
  const issueLabels = issue ? labelsOf(issue) : [];
  if (!issue || issue.pull_request || issue.state !== "open" || !issueLabels.includes("ready") || issueLabels.some((l) => EPIKU_ISSUE_PARKED.includes(l))) {
    no("issue", "its first line does not close an open issue labelled `ready` (and not parked)");
  }
  const changed = (pr.additions ?? 0) + (pr.deletions ?? 0);
  if (changed > MAX_CHANGED_LINES) no("size", `${changed} changed lines (max ${MAX_CHANGED_LINES})`);
  if (files.length >= GITHUB_FILES_CAP || (Number.isInteger(pr.changed_files) && files.length !== pr.changed_files)) {
    no("files", `file list incomplete (${files.length} of ${pr.changed_files} files): the paths can't be verified`);
  }
  const paths = [...new Set(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  const blocked = paths.filter((n) => EPIKU_HUMAN_ONLY.some((re) => re.test(n)));
  if (blocked.length) no("human-only", `touches human-only paths: ${blocked.join(", ")}`);
  const guards = paths.filter((n) => EPIKU_GUARD_TESTS.some((re) => re.test(n)));
  if (guards.length) no("guard-test", `changes a guard test (${guards.join(", ")}): the owner checks it was not loosened`);
  const code = files.filter((f) => !isDoc(f.filename));
  const envReads = code.filter((f) => typeof f.patch === "string" && addedLines(f.patch).some((l) => ENV_READ.test(l))).map((f) => f.filename);
  if (envReads.length) no("env-read", `adds or changes a read of an environment variable or secret (${envReads.join(", ")})`);
  const blind = code.filter((f) => (f.additions ?? 0) > 0 && typeof f.patch !== "string").map((f) => f.filename);
  if (blind.length) no("no-diff", `GitHub returned no diff for ${blind.join(", ")}: its added lines can't be checked`);
  // A route file that disappears or moves changes an existing API contract, whatever the review says.
  const routes = files.filter((f) => ["removed", "renamed"].includes(f.status))
    .flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)).filter((n) => /^app\/api\//i.test(n));
  if (routes.length) no("api-removed", `removes or moves an API route file (${[...new Set(routes)].join(", ")}): a breaking API change`);
  if (verdict === "approve") {
    if (!DATA_CLASSES.includes(dataClass)) no("data-class", "the approving review carries no data/API classification for this commit");
    else if (dataClass === "breaking") no("breaking", "the review classifies it as a breaking data or API change: the owner merges those");
    else if (dataClass === "additive") {
      const kept = (re) => files.some((f) => re.test(f.filename) && f.status !== "removed");
      const missing = [
        kept(/^tests\/.+\.test\.[cm]?[jt]sx?$/i) ? null : "a test under `tests/` (one that loads old-shape data)",
        kept(/^docs\/data-safety\.md$/i) ? null : "`docs/DATA-SAFETY.md`",
        kept(/^docs\/features\.md$/i) ? null : "`docs/FEATURES.md`",
      ].filter(Boolean);
      if (missing.length) no("additive-proof", `an additive data or API change must also change ${missing.join(", ")}`);
    }
  }
  if (pr.mergeable === false) no("conflicts", "the PR has merge conflicts");
  if (pr.mergeable == null) no("mergeability", "GitHub hasn't computed mergeability yet", true);
  return r;
}

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
export function parseVerdict(text, secrets = [], { dataClass = false } = {}) {
  let v;
  try { v = JSON.parse(text); } catch { return { error: "verdict file is not valid JSON" }; }
  if (!v || !["approve", "changes"].includes(v.verdict)) return { error: 'verdict must be "approve" or "changes"' };
  if (typeof v.body !== "string" || v.body.trim().length < 20 || v.body.length > 20000) return { error: "body must be 20–20000 chars" };
  const s = secrets.map((x) => x.trim()).filter((x) => x.length >= 8);
  if (s.some((x) => v.body.includes(x))) return { error: "the review contains a secret value — not posted" };
  // Epiku: the reviewer must also classify the change (DATA_CLASSES); an approval without it can't merge.
  if (dataClass && !DATA_CLASSES.includes(v.data_change)) return { error: `data_change must be one of ${DATA_CLASSES.join(" | ")}` };
  return dataClass ? { verdict: v.verdict, body: v.body, dataClass: v.data_change } : { verdict: v.verdict, body: v.body };
}

/** "Not yet" reasons that shouldn't park a PR. */
const transient = (w) => /^CI is (pending|none)|^no approving review|^GitHub hasn't computed|^the beta channel isn't live/.test(w);

export function betaChannelLive(gh) {
  try { return !!gh.get(`repos/${APP_REPO}/contents/.github/workflows/promote.yml?ref=main`)?.sha; } catch { return false; }
}

export function reviewQueue(gh, ids, repo = APP_REPO) {
  const out = [];
  for (const p of gh.list(`repos/${repo}/pulls?state=open`)) {
    const l = labelsOf(p);
    if (!l.includes("agent") || l.includes("needs-owner") || l.includes("in-progress") || p.draft) continue;
    if (!sameLogin(p.user?.login, ids.builder) || p.head?.repo?.full_name !== repo || p.base?.ref !== "main") continue;
    if (ciStatus(gh, repo, p.head.sha) !== "success") continue;
    if (verdictFor(gh.list(`repos/${repo}/issues/${p.number}/comments`), p.head.sha, ids.reviewer)) continue;
    out.push(p);
  }
  return out;
}

export function postReview(gh, reviewerGh, ids, n, sha, verdict, body, repo = APP_REPO, dataClass = null) {
  if (!["approve", "changes"].includes(verdict)) throw new Error("verdict must be approve|changes");
  if (dataClass != null && !DATA_CLASSES.includes(dataClass)) throw new Error(`data class must be ${DATA_CLASSES.join("|")}`);
  const pr = gh.get(`repos/${repo}/pulls/${n}`);
  if (pr.head.sha !== sha) throw new Error(`head moved: reviewed ${sha.slice(0, 7)}, PR is now at ${pr.head.sha.slice(0, 7)} — review it again`);
  // With separate bot accounts the reviewer must not have opened the PR. In
  // Actions both are github-actions[bot]; independence comes from the agents
  // holding no token (identity.mjs).
  if (!sameLogin(ids.builder, ids.reviewer) && sameLogin(pr.user?.login, ids.reviewer)) throw new Error("the reviewer can't review its own PR");
  assertActingAs(reviewerGh, ids.reviewer, ids);
  reviewerGh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `${sanitize(body).trim()}\n\n${dataClass ? `${dataMarker(sha, dataClass)}\n` : ""}${marker(sha, verdict)}` });
  if (verdict === "approve" && dataClass === "breaking") {
    // Sound work, but never auto-merged: parked now, so no merge step even looks at it.
    reviewerGh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["needs-owner"] });
    reviewerGh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `The review approves this but classifies it as a **breaking** data or API change (VISION.md §2). Those are never auto-merged: parked for the owner to read and merge.\n\n<!-- octopush-automerge:${sha}:breaking -->` });
  }
  if (verdict === "changes") {
    const rounds = reviewRounds(gh.list(`repos/${repo}/issues/${n}/comments`), ids.reviewer);
    if (rounds >= MAX_REVIEW_ROUNDS) {
      reviewerGh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["needs-owner"] });
      reviewerGh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Sent back ${rounds} times — parking for the owner instead of another nightly round.\n\n<!-- octopush-automerge:${sha}:rounds -->` });
    }
  }
  return pr;
}

/** Approved-on-head builder PRs still open (a merge left for a transient reason). */
export function approvedQueue(gh, ids, repo = APP_REPO) {
  const out = [];
  for (const p of gh.list(`repos/${repo}/pulls?state=open`)) {
    const l = labelsOf(p);
    // in-progress: the builder has claimed it for another round — not now.
    if (!l.includes("agent") || l.includes("needs-owner") || l.includes("in-progress") || p.draft) continue;
    if (!sameLogin(p.user?.login, ids.builder) || p.head?.repo?.full_name !== repo) continue;
    if (verdictFor(gh.list(`repos/${repo}/issues/${p.number}/comments`), p.head.sha, ids.reviewer) === "approve") out.push(p);
  }
  return out;
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // sleeps, doesn't spin

export function tryMerge(gh, actGh, n, ids, { waitMs = 3000, tries = 6 } = {}) {
  // GitHub computes mergeability lazily (null right after main moves): ask again briefly.
  let pr = gh.get(`repos/${APP_REPO}/pulls/${n}`);
  for (let i = 1; pr.mergeable == null && i < tries; i++) { sleepMs(waitMs); pr = gh.get(`repos/${APP_REPO}/pulls/${n}`); }
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

/**
 * Epiku's guarded merge: re-read everything on the PR's current head, refuse
 * on any rule of `epikuRefusals`, else merge that exact commit. One client:
 * in Epiku the App's bot reads, comments and merges. With `dryRun` nothing is
 * written (no label, no comment, no merge): it reports what a real run would do.
 */
export function tryMergeEpiku(gh, n, ids, { waitMs = 3000, tries = 6, dryRun = false } = {}) {
  const repo = EPIKU_REPO;
  let pr = gh.get(`repos/${repo}/pulls/${n}`);
  for (let i = 1; pr.mergeable == null && i < tries; i++) { sleepMs(waitMs); pr = gh.get(`repos/${repo}/pulls/${n}`); }
  const sha = pr.head.sha;
  const files = gh.list(`repos/${repo}/pulls/${n}/files`, GITHUB_FILES_CAP);
  const comments = gh.list(`repos/${repo}/issues/${n}/comments`);
  // The builder's PR body starts with `Closes #<n>` (publish-build.mjs); nothing later in it counts.
  const closes = /^closes #(\d+)\s*(\n|$)/i.exec(pr.body ?? "")?.[1];
  let issue = null;
  if (closes) { try { issue = gh.get(`repos/${repo}/issues/${closes}`); } catch { /* unreadable: refused below */ } }
  const why = epikuRefusals({
    pr, files, issue, ids,
    ci: ciStatus(gh, repo, sha),
    verdict: verdictFor(comments, sha, ids.reviewer),
    dataClass: dataClassFor(comments, sha, ids.reviewer),
  });
  if (why.length) {
    if (!dryRun && why.some((w) => !w.transient)) {
      gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["needs-owner"] });
      gh.send("POST", `repos/${repo}/issues/${n}/comments`, {
        body: `Not auto-merged — needs the owner:\n\n${why.map((w) => `- ${sanitize(w.text)}`).join("\n")}\n\n<!-- octopush-automerge:${sha}:refused -->`,
      });
    }
    return { merged: false, why, sha };
  }
  if (dryRun) return { merged: false, why: [], sha, wouldMerge: true };
  const res = gh.send("PUT", `repos/${repo}/pulls/${n}/merge`, { merge_method: "merge", sha });
  return { merged: !!res?.merged, why: res?.merged ? [] : [{ code: "merge-failed", text: res?.message ?? "merge failed", transient: true }], sha };
}

async function main() {
  let argv = process.argv.slice(2);
  let repo = APP_REPO;
  if (argv[0] === "--repo") { repo = argv[1]; argv = argv.slice(2); }
  if (![APP_REPO, WEB_REPO, EPIKU_REPO].includes(repo)) throw new Error(`--repo is ${APP_REPO}, ${WEB_REPO} or ${EPIKU_REPO}`);
  const [cmd, a, b, c, d] = argv;
  const ids = idsForRepo(requireIdentities(loadIdentities()), repo);
  if (tokenEnvFor(repo)) {
    // The App's repos: its installation token (OCTOPUSH_WEB_TOKEN / OCTOPUSH_EPIKU_TOKEN) reads and posts.
    // Website PRs are reviewed only; Epiku's are also merged, under epikuRefusals.
    const epiku = repo === EPIKU_REPO;
    const tag = epiku ? "epiku" : "web";
    const gh = ghForRepo(repo);
    if (cmd === "queue") {
      // Epiku is private: its queue carries numbers and commits, never a title or URL.
      for (const p of reviewQueue(gh, ids, repo)) console.log(epiku ? `${p.number}\t${p.head.sha}` : `${p.number}\t${p.head.sha}\t${p.title}\t${p.html_url}`);
      return 0;
    }
    if (cmd === "review-json") {
      if (!/^\d+$/.test(a ?? "") || !/^[0-9a-f]{40}$/.test(b ?? "") || !c) throw new Error(`usage: --repo <${tag}> review-json <n> <head-sha> <file>`);
      const v = parseVerdict(readFileSync(c, "utf8"), (process.env.OCTOPUSH_SECRETS ?? "").split("\n"), { dataClass: epiku });
      if (v.error) { console.error(`not posted ${tag}#${a}: ${v.error}`); return 1; }
      postReview(gh, gh, ids, Number(a), b, v.verdict, v.body, repo, v.dataClass ?? null);
      console.log(`posted ${v.verdict} on ${tag}#${a} at ${b.slice(0, 7)}`);
      return 0;
    }
    if (epiku && cmd === "approved") {
      for (const p of approvedQueue(gh, ids, repo)) console.log(String(p.number));
      return 0;
    }
    if (epiku && cmd === "merge") {
      if (!/^\d+$/.test(a ?? "") || (b !== undefined && b !== "--dry-run")) throw new Error("usage: --repo <epiku> merge <pr-number> [--dry-run]");
      assertActingAs(gh, ids.reviewer, ids);
      const dryRun = b === "--dry-run";
      const r = tryMergeEpiku(gh, Number(a), ids, { dryRun });
      const at = String(r.sha).slice(0, 7);
      if (r.merged) { console.log(`merged epiku#${a} at ${at}`); return 0; }
      if (r.wouldMerge) { console.log(`dry run: epiku#${a} at ${at} would be merged`); return 0; }
      // Reason codes only: the reasons themselves name files of a private repo and are on the PR.
      console.log(`${dryRun ? "dry run: " : ""}not merged epiku#${a} at ${at}: ${r.why.map((w) => w.code).join(", ")}`);
      return 1;
    }
    console.error(epiku
      ? `usage: automerge.mjs --repo ${EPIKU_REPO} queue | review-json <n> <sha> <file> | approved | merge <n> [--dry-run]`
      : `usage: automerge.mjs --repo ${WEB_REPO} queue | review-json <n> <sha> <file> (website PRs never auto-merge)`);
    return 64;
  }
  const gh = makeGh(); // the builder's default login — used for reads
  const reviewerGh = () => makeGh(ghRunAs(reviewerToken()));
  if (cmd === "approved") {
    for (const p of approvedQueue(gh, ids)) console.log(String(p.number)); // numbers only: titles never reach the log
    return 0;
  }
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
  console.error("usage: automerge.mjs check | queue | approved | review <n> <sha> approve|changes <file> | merge <n>");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code), (e) => { reportFatal("automerge", e); process.exit(2); });
}
