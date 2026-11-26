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
//                                               ({"verdict":"approve|changes","body":"…",
//                                               "user_visible":true|false,"user_visible_reason":"…"})
//                                               after validating it and scanning it for secrets
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
import { makeGh, ghRunAs, ghForRepo, APP_REPO, WEB_REPO, EPIKU_REPO, tokenEnvFor, markPrivate, safeError, ciStatus, mainCi, labelsOf, sanitize, reportFatal } from "./gh.mjs";
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
  /(^|\/)\.gitattributes$/i, /(^|\/)\.gitmodules$/i,
  // Real project plans: read-only for agents, and nothing of theirs may be copied anywhere.
  /^data(\/|$)/i,
  // Authentication and tokens.
  /^lib\/(identidad|auth|api)\.[cm]?[jt]sx?$/i, /^scripts\/tokens\.py$/i,
  // Deploy and environment configuration.
  /^next\.config\.[^/]+$/i, /^vercel\.json$/i, /^\.vercel(\/|$)/i, /^\.vercelignore$/i,
  /^\.npmrc$/i, /^\.nvmrc$/i, /(^|\/)\.env[^/]*$/i,
  // Code Next runs on every request or at server start, outside any route's permission check.
  /^(src\/)?(proxy|middleware)\.[cm]?[jt]sx?$/i, /^(src\/)?instrumentation[^/]*\.[cm]?[jt]sx?$/i,
  // Build and test configuration: executed by CI and by the build (stricter than Epiku's VISION.md §2).
  /^tsconfig[^/]*\.json$/i, /^postcss\.config\.[^/]+$/i, /^vitest\.config\.[^/]+$/i,
  // Dependencies.
  /^package(-lock)?\.json$/i, /^npm-shrinkwrap\.json$/i, /^pnpm-lock\.yaml$/i, /^yarn\.lock$/i,
];
/**
 * Epiku's two guard tests (every route checks permissions; backups restore).
 * An agent may change them, saying why, but such a PR is never auto-merged:
 * loosening one is how tenant isolation or the restore path would break quietly.
 */
export const EPIKU_GUARD_TESTS = [/^tests\/rutas\.test\.[cm]?[jt]sx?$/i, /^tests\/backup-roundtrip\.test\.[cm]?[jt]sx?$/i];
/**
 * Paths an Epiku PR may change but that are never auto-merged, by path alone.
 * OWNER DECISION, empty for now: the storage layer and the route handlers stay
 * auto-mergeable under the review and the other rules. To park every PR that
 * touches them, list them here, e.g. [/^lib\/almacen\.ts$/i, /^app\/api\//i].
 */
export const EPIKU_PARK_PATHS = [];
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

/**
 * Added lines that could read an environment variable or a secret (human-only
 * in Epiku, whatever the file). Deliberately broad — any use or aliasing of
 * `process`, `globalThis`, `import.meta.env`, a quoted "env" key, Python's
 * environ — because parking a harmless PR costs the owner a minute. It is a
 * tripwire, not a proof: the reviewer's brief carries the rule itself.
 */
const ENV_READ = [
  /\bprocess\s*(\?\.|\.|\[)/, /[=(,:]\s*process\b/, /["'`](node:)?process["'`]/,
  /\bglobalThis\b/, /\bglobal\s*(\?\.|\.|\[)/,
  /\bimport\s*\.\s*meta\s*(\?\.|\.|\[)\s*["'`]?env\b/, /[=(,:]\s*import\s*\.\s*meta\b(?!\s*\.\s*(url|dirname|filename)\b)/,
  /["'`]env["'`]/, /\benviron\b/, /\bgetenv\b/, /\bDeno\s*\./, /\bBun\s*\./,
  /dotenv/i, /loadEnvConfig/, /@next\/env/,
];
export const readsEnv = (line) => ENV_READ.some((re) => re.test(line));
const addedLines = (patch) => String(patch).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
const hunks = (patch) => String(patch).split(/^(?=@@)/m);
const isDoc = (n) => /\.mdx?$/i.test(n);
const EPIKU_ISSUE_PARKED = ["needs-owner", "proposal", "later"];
/** Where the browser keeps the token (`useToken`): human-only, inside a file that otherwise isn't. */
const TOKEN_STORE_FILE = /^lib\/store\.[cm]?[jt]sx?$/i;
const TOKEN_STORE = /token|localStorage|sessionStorage|cookie/i;
/** The builder's branches in Epiku, as publish-build.mjs names them. */
export const EPIKU_BRANCH = /^agent\/issue-\d+$/;

/**
 * Comments that can carry a verdict in Epiku: written by the cycle's App bot
 * — matched by its numeric account id, not its login — and never edited since
 * (a maintainer can edit anyone's comment; an edit moves `updated_at`).
 */
export function trustedComments(comments, botId) {
  return comments.filter((c) => Number.isInteger(botId) && c.user?.id === botId && typeof c.created_at === "string" && c.created_at === c.updated_at);
}

/** Was the issue's `ready` label last applied by the owner, and not removed since? (issue events, oldest first) */
export function readyByOwner(events, owner) {
  const last = events.filter((e) => ["labeled", "unlabeled"].includes(e.event) && e.label?.name === "ready").at(-1);
  return !!last && last.event === "labeled" && sameLogin(last.actor?.login, owner);
}

/**
 * Is every commit of the PR the bot's? Author and committer must be the App's
 * bot (by account id). The one exception is the merge commit GitHub itself
 * writes when the merge script updates the branch from main: authored by the
 * bot, committed and signed by GitHub.
 */
export function commitsByBot(commits, botId) {
  if (!Number.isInteger(botId) || !commits.length || commits.length >= 250) return false; // 250: the API's cap — can't see them all
  return commits.every((c) => c.author?.id === botId && (c.committer?.id === botId
    || (c.committer?.login === "web-flow" && c.parents?.length === 2 && c.commit?.verification?.verified === true)));
}

/** Did the App's bot make the latest push to the branch, and is it this commit? (repository activity, newest first) */
export function pushedByBot(activity, sha, botId) {
  const last = activity[0];
  return Number.isInteger(botId) && !!last && last.after === sha && last.actor?.id === botId;
}

/**
 * Why an Epiku agent PR must NOT be auto-merged (pure). Each reason is
 * `{ code, text, transient? }`: the code is all that reaches this public
 * repo's log, the text goes into the comment on the private PR. Mirrors the
 * six auto-merge conditions of Epiku's VISION.md §2, the app lane's size cap,
 * and the checks a script can make for what those conditions leave to judgement:
 *   - `issue` is the issue the PR body closes (`Closes #n` on its first line), or null;
 *   - `dataClass` is the reviewer's signed classification for the head commit.
 *   - `provenance` is what tryMergeEpiku established from GitHub about who did
 *     what: `{ author, ready, commits, pusher }` (the PR author's account id, readyByOwner,
 *     commitsByBot, pushedByBot);
 *     anything not `true` refuses;
 *   - `behind` is how many commits of main the head lacks (0 = up to date).
 * A `transient` reason means "not yet" and never parks the PR.
 */
export function epikuRefusals({ pr, files, ci, verdict, dataClass, issue, ids, provenance = {}, behind = null }) {
  const r = [];
  const no = (code, text, transient = false) => r.push(transient ? { code, text, transient } : { code, text });
  const labels = labelsOf(pr);
  const sha7 = String(pr.head?.sha).slice(0, 7);
  if (pr.state !== "open") no("closed", "the PR is not open");
  if (pr.draft) no("draft", "the PR is a draft");
  if (!labels.includes("agent")) no("label", "the PR is not labelled `agent`");
  if (labels.includes("needs-owner")) no("needs-owner", "the PR is labelled `needs-owner`");
  if (labels.includes("in-progress")) no("in-progress", "the builder is working on it (`in-progress`)", true);
  if (!sameLogin(pr.user?.login, ids.builder) || provenance.author !== true) no("author", "the PR was not opened by the cycle's builder");
  if (pr.head?.repo?.full_name !== EPIKU_REPO || pr.base?.repo?.full_name !== EPIKU_REPO || pr.base?.ref !== "main" || !EPIKU_BRANCH.test(pr.head?.ref ?? "")) no("branch", "it must be a PR from one of the builder's branches of this repo into main");
  if (provenance.commits !== true) no("commits", "not every commit on the branch is authored and committed by the cycle's App");
  if (provenance.pusher !== true) no("pusher", "the head commit is not the latest push to the branch by the cycle's App");
  if (ci !== "success") no("ci", `CI is ${ci} on ${sha7}`, ci === "pending" || ci === "none");
  if (verdict !== "approve") no("review", verdict === "changes" ? "the review requested changes" : `no approving review on ${sha7}`, verdict == null);
  const issueLabels = issue ? labelsOf(issue) : [];
  if (!issue || issue.pull_request || issue.state !== "open" || !issueLabels.includes("ready") || issueLabels.some((l) => EPIKU_ISSUE_PARKED.includes(l))) {
    no("issue", "its first line does not close an open issue labelled `ready` (and not parked)");
  } else if (provenance.ready !== true) no("issue-owner", "the `ready` label on its issue was not applied by the owner");
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
  const parkPaths = paths.filter((n) => EPIKU_PARK_PATHS.some((re) => re.test(n)));
  if (parkPaths.length) no("park-path", `touches paths the owner merges himself: ${parkPaths.join(", ")}`);
  const code = files.filter((f) => !isDoc(f.filename));
  const envReads = code.filter((f) => typeof f.patch === "string" && addedLines(f.patch).some(readsEnv)).map((f) => f.filename);
  if (envReads.length) no("env-read", `may add or change a read of an environment variable or secret (${envReads.join(", ")})`);
  // No patch at all — a binary file, a file with a NUL byte in it, a pure rename, a very large
  // diff: whatever the line counts say, nothing above could look inside it.
  const blind = code.filter((f) => typeof f.patch !== "string").map((f) => f.filename);
  if (blind.length) no("no-diff", `GitHub returned no diff for ${blind.join(", ")}: it can't be checked`);
  const tokenStore = files.filter((f) => TOKEN_STORE_FILE.test(f.filename) && typeof f.patch === "string" && hunks(f.patch).some((h) => TOKEN_STORE.test(h))).map((f) => f.filename);
  if (tokenStore.length) no("token-store", `changes code next to how the browser stores the token (${tokenStore.join(", ")})`);
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
  // CI was green on this commit, not on what main would become with it: two green PRs can break
  // main together. Only a head that already contains main merges; the script updates the branch
  // instead (a new commit: CI and the review run again on it).
  if (behind !== 0) no("behind", Number.isInteger(behind) ? `the branch is ${behind} commit(s) behind main` : "can't tell whether the branch contains main", true);
  return r;
}

/**
 * User-visible change heuristic: non-test code under src/ (frontend) or
 * src-tauri/src/. Used only when the reviewer's verdict doesn't say (see
 * `visibleMarker`): it parks backend-only slices, comment and docs fixes too.
 */
const isTest = (n) => /\.test\.[cm]?[jt]sx?$/i.test(n) || /(^|\/)tests?\.rs$/i.test(n) || /(^|\/)tests?\//i.test(n);
const USER_VISIBLE = (n) => /^(src|src-tauri\/src)\//.test(n) && !isTest(n);
const CHANGESET = /^whats-new\/unreleased\/[a-z0-9-]+\.md$/;

export const marker = (sha, verdict) => `<!-- octopush-review:${sha}:${verdict} -->`;
const markerRe = (sha) => new RegExp(`<!-- octopush-review:${sha}:(approve|changes) -->`, "g");

/**
 * The app reviewer's answer to "would a user notice this change?", signed by
 * postReview into the verdict comment right before the other markers, for that
 * commit (agent text can't carry it: sanitize). It decides whether a missing
 * changeset parks the PR; without it, the path heuristic decides, as before.
 */
export const visibleMarker = (sha, visible) => `<!-- octopush-visible:${sha}:${visible ? "true" : "false"} -->`;
export const MAX_VISIBLE_REASON = 200;
/** true | false from the reviewer's latest verdict comment on `sha`, or null (no answer: use the heuristic). */
export function userVisibleFor(comments, sha, reviewer) {
  const tail = new RegExp(`<!-- octopush-visible:${sha}:(true|false) -->\\n(?:<!-- octopush-data:${sha}:(?:none|additive|breaking) -->\\n)?<!-- octopush-review:${sha}:(?:approve|changes) -->$`);
  let v = null;
  for (const c of comments) {
    if (!sameLogin(c.user?.login, reviewer)) continue;
    const body = (c.body ?? "").trimEnd();
    if (!new RegExp(`<!-- octopush-review:${sha}:(?:approve|changes) -->$`).test(body)) continue;
    const m = tail.exec(body)?.[1];
    v = m === "true" ? true : m === "false" ? false : null; // a later verdict without the answer clears an earlier one
  }
  return v;
}

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

/**
 * Pure rule check. Returns a list of reasons the PR may NOT be merged.
 *   - `userVisible`: the reviewer's signed answer (userVisibleFor) — true, false or null
 *     (no answer: the path heuristic decides whether a changeset is required);
 *   - `main`: mainCi's `{ state, sha }`, or `{ state: "error" }` when it couldn't be read;
 *   - `behind`: how many commits of main the head lacks (null: unknown) — while main is red,
 *     only a head that contains it may merge (its green CI then proves the fix);
 *   - `release`: the number of an open release PR, "error" when that couldn't be read, or null.
 * Paused, conflicted and not-yet reasons are transient: they never park the PR.
 */
export function refusals({ pr, files, ci, verdict, ids, betaLive, userVisible = null, main = null, behind = null, release = null }) {
  const r = [];
  const labels = labelsOf(pr);
  if (!betaLive) r.push("the beta channel isn't live yet (no .github/workflows/promote.yml on main) — auto-merge would reach every user");
  if (release === "error") r.push("paused: can't tell whether a release PR is open — retried next run");
  else if (release != null) r.push(`paused: release PR #${release} is open — merges wait until it lands, so the release merges the main it tested`);
  if (main?.state === "error") r.push("paused: can't read main's CI — retried next run");
  else if (main?.state === "red" && behind !== 0) r.push(`paused: main's CI is red at ${String(main.redSha ?? main.sha).slice(0, 7)} — merges wait until it is green (a PR whose head contains main may still merge)`);
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
  // The reviewer's answer wins either way; only without one does the path heuristic decide.
  const visible = typeof userVisible === "boolean" ? userVisible : files.some((f) => USER_VISIBLE(f.filename));
  const hasChangeset = files.some((f) => CHANGESET.test(f.filename) && f.status !== "removed");
  if (visible && !hasChangeset) r.push(`user-visible change without a whats-new changeset${userVisible === true ? " (the review says users will notice it)" : ""}`);
  // A fix round, not a park: the builder merges main, resolves the conflicts and the PR is reviewed again (jobs.mjs).
  if (pr.mergeable === false) r.push("PR has merge conflicts — the builder resolves them in a fix round");
  if (pr.mergeable == null) r.push("GitHub hasn't computed mergeability yet");
  return r;
}

/**
 * The reviewer's `user_visible` answer, if it gave a usable one: a boolean and a
 * one-line reason (its first line, capped). Anything else is no answer, which
 * keeps the path heuristic: a malformed field can only make the rule stricter.
 */
export function visibleAnswer(v) {
  if (typeof v?.user_visible !== "boolean" || typeof v.user_visible_reason !== "string") return null;
  const reason = v.user_visible_reason.split("\n")[0].replace(/\s+/g, " ").trim();
  if (reason.length < 3) return null;
  return { userVisible: v.user_visible, userVisibleReason: reason.length > MAX_VISIBLE_REASON ? `${reason.slice(0, MAX_VISIBLE_REASON - 1)}…` : reason };
}

/** Validate a reviewer agent's verdict file. Returns { verdict, body[, userVisible, userVisibleReason] } or { error }. */
export function parseVerdict(text, secrets = [], { dataClass = false } = {}) {
  let v;
  try { v = JSON.parse(text); } catch { return { error: "verdict file is not valid JSON" }; }
  if (!v || !["approve", "changes"].includes(v.verdict)) return { error: 'verdict must be "approve" or "changes"' };
  if (typeof v.body !== "string" || v.body.trim().length < 20 || v.body.length > 20000) return { error: "body must be 20–20000 chars" };
  const s = secrets.map((x) => x.trim()).filter((x) => x.length >= 8);
  const visible = dataClass ? null : visibleAnswer(v);
  if (s.some((x) => v.body.includes(x) || visible?.userVisibleReason.includes(x))) return { error: "the review contains a secret value — not posted" };
  // Epiku: the reviewer must also classify the change (DATA_CLASSES); an approval without it can't merge.
  if (dataClass && !DATA_CLASSES.includes(v.data_change)) return { error: `data_change must be one of ${DATA_CLASSES.join(" | ")}` };
  return dataClass ? { verdict: v.verdict, body: v.body, dataClass: v.data_change } : { verdict: v.verdict, body: v.body, ...(visible ?? {}) };
}

/** "Not yet" reasons that shouldn't park a PR (paused, conflicts: a fix round). */
const transient = (w) => /^CI is (pending|none)|^no approving review|^GitHub hasn't computed|^the beta channel isn't live|^paused: |^PR has merge conflicts/.test(w);

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
    // A conflicted app PR goes to the builder first (a fix round merges main): its head will change.
    if (repo === APP_REPO && gh.get(`repos/${repo}/pulls/${p.number}`)?.mergeable === false) continue;
    out.push(p);
  }
  return out;
}

/**
 * Post a verdict as the reviewer. `visible` is the app reviewer's
 * `{ userVisible, userVisibleReason }` (visibleAnswer), or null: its reason is
 * shown in the comment and its answer signed next to the verdict.
 */
export function postReview(gh, reviewerGh, ids, n, sha, verdict, body, repo = APP_REPO, dataClass = null, visible = null) {
  if (!["approve", "changes"].includes(verdict)) throw new Error("verdict must be approve|changes");
  if (dataClass != null && !DATA_CLASSES.includes(dataClass)) throw new Error(`data class must be ${DATA_CLASSES.join("|")}`);
  if (visible != null && typeof visible.userVisible !== "boolean") throw new Error("user_visible must be true|false");
  const pr = gh.get(`repos/${repo}/pulls/${n}`);
  if (pr.head.sha !== sha) throw safeError(`head moved: reviewed ${sha.slice(0, 7)}, PR is now at ${pr.head.sha.slice(0, 7)} — review it again`);
  // With separate bot accounts the reviewer must not have opened the PR. In
  // Actions both are github-actions[bot]; independence comes from the agents
  // holding no token (identity.mjs).
  if (!sameLogin(ids.builder, ids.reviewer) && sameLogin(pr.user?.login, ids.reviewer)) throw new Error("the reviewer can't review its own PR");
  assertActingAs(reviewerGh, ids.reviewer, ids);
  const seen = visible ? `**User-visible:** ${visible.userVisible ? "yes" : "no"} — ${sanitize(visible.userVisibleReason).replace(/\s+/g, " ").trim()}\n\n` : "";
  const markers = [visible ? visibleMarker(sha, visible.userVisible) : null, dataClass ? dataMarker(sha, dataClass) : null, marker(sha, verdict)].filter(Boolean).join("\n");
  reviewerGh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `${sanitize(body).trim()}\n\n${seen}${markers}` });
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

/**
 * The open release PR (release-beta.sh's `release/vX.Y.Z` branch of this repo
 * into main), by number, or null. While one is open, auto-merge waits: a merge
 * would make the release PR's merge commit a main its CI never tested (#1063).
 */
export const RELEASE_BRANCH = /^release\/v\d+\.\d+\.\d+$/;
/**
 * A release run lasts at most nightly-release.yml's job timeout (230 min). A release
 * PR untouched for longer was left by a run that was killed: it no longer pauses
 * anything (the next release run reuses or closes it).
 */
export const RELEASE_PR_STALE_MS = 4 * 3600e3;
export function openReleasePr(gh, repo = APP_REPO, now = Date.now()) {
  return gh.list(`repos/${repo}/pulls?state=open`)
    .find((p) => RELEASE_BRANCH.test(p.head?.ref ?? "") && p.head?.repo?.full_name === repo && p.base?.ref === "main"
      && !(now - Date.parse(p.updated_at) > RELEASE_PR_STALE_MS))?.number ?? null;
}

export function tryMerge(gh, actGh, n, ids, { waitMs = 3000, tries = 6 } = {}) {
  // GitHub computes mergeability lazily (null right after main moves): ask again briefly.
  let pr = gh.get(`repos/${APP_REPO}/pulls/${n}`);
  for (let i = 1; pr.mergeable == null && i < tries; i++) { sleepMs(waitMs); pr = gh.get(`repos/${APP_REPO}/pulls/${n}`); }
  const files = gh.list(`repos/${APP_REPO}/pulls/${n}/files`, GITHUB_FILES_CAP);
  const comments = gh.list(`repos/${APP_REPO}/issues/${n}/comments`);
  const ci = ciStatus(gh, APP_REPO, pr.head.sha);
  const verdict = verdictFor(comments, pr.head.sha, ids.reviewer);
  // The pauses fail closed: a lookup that fails is "paused", retried next run.
  let main, release, behind = null;
  try { main = mainCi(gh, APP_REPO); } catch { main = { state: "error" }; }
  try { release = openReleasePr(gh, APP_REPO); } catch { release = "error"; }
  if (main.state === "red") { try { behind = gh.get(`repos/${APP_REPO}/compare/${main.sha}...${pr.head.sha}`)?.behind_by ?? null; } catch { behind = null; } }
  const why = refusals({ pr, files, ci, verdict, ids, betaLive: betaChannelLive(gh), userVisible: userVisibleFor(comments, pr.head.sha, ids.reviewer), main, behind, release });
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
  // Anything that can't be read counts as "no": every lookup below fails closed.
  const or = (fallback, fn) => { try { return fn(); } catch { return fallback; } };
  const botId = or(null, () => gh.get(`users/${encodeURIComponent(ids.reviewer)}`)?.id);
  const files = gh.list(`repos/${repo}/pulls/${n}/files`, GITHUB_FILES_CAP);
  // Verdicts count only from unedited comments of the App's bot account (by id).
  const comments = trustedComments(gh.list(`repos/${repo}/issues/${n}/comments`), botId);
  // The builder's PR body starts with `Closes #<n>` (publish-build.mjs); nothing later in it counts.
  const closes = /^closes #(\d+)\s*(\n|$)/i.exec(pr.body ?? "")?.[1];
  const issue = closes ? or(null, () => gh.get(`repos/${repo}/issues/${closes}`)) : null;
  const branch = EPIKU_BRANCH.test(pr.head?.ref ?? "") ? pr.head.ref : null;
  const provenance = {
    author: Number.isInteger(botId) && pr.user?.id === botId, // the account, not just a login that reads the same
    ready: !!closes && readyByOwner(or([], () => gh.list(`repos/${repo}/issues/${closes}/events`, 500)), ids.owner),
    commits: commitsByBot(or([], () => gh.list(`repos/${repo}/pulls/${n}/commits`, 250)), botId),
    pusher: !!branch && pushedByBot(or([], () => gh.get(`repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=30`) ?? []), sha, botId),
  };
  const behind = or(null, () => gh.get(`repos/${repo}/compare/main...${sha}`)?.behind_by);
  const why = epikuRefusals({
    pr, files, issue, ids, provenance, behind: Number.isInteger(behind) ? behind : null,
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
    } else if (!dryRun && why.length === 1 && why[0].code === "behind" && Number.isInteger(behind)) {
      // Everything else holds: bring main into the branch. That is a new head — CI runs on it
      // and the review must approve it again before the next run can merge it.
      try {
        gh.send("PUT", `repos/${repo}/pulls/${n}/update-branch`, { expected_head_sha: sha });
        return { merged: false, why, sha, updated: true };
      } catch {
        // Never left waiting silently: if the branch can't be updated, the owner hears about it.
        const stuck = { code: "update-failed", text: "the branch is behind main and could not be updated automatically" };
        gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["needs-owner"] });
        gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Not auto-merged — needs the owner:\n\n- ${stuck.text}\n\n<!-- octopush-automerge:${sha}:refused -->` });
        return { merged: false, why: [...why, stuck], sha };
      }
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
  markPrivate(repo);
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
      console.log(`${dryRun ? "dry run: " : ""}not merged epiku#${a} at ${at}: ${r.why.map((w) => w.code).join(", ")}${r.updated ? " (branch updated from main; CI and the review run again)" : ""}`);
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
    const visible = typeof v.userVisible === "boolean" ? { userVisible: v.userVisible, userVisibleReason: v.userVisibleReason } : null;
    postReview(gh, reviewerGh(), ids, Number(a), b, v.verdict, v.body, APP_REPO, null, visible);
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
