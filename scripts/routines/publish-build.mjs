#!/usr/bin/env node
// Publish what a nightly builder agent produced (docs/ROUTINES.md, nightly-build.yml).
// Runs AFTER the agent, from a copy of scripts/routines taken before it started,
// with the workflow's GITHUB_TOKEN. The agent itself never touches GitHub.
//
//   publish-build.mjs <issue|pr|app-issue> <number> [branch]
//
// The repo it publishes to is OCTOPUSH_PUBLISH_REPO (default GITHUB_REPOSITORY).
// For octopush-web (web-build.yml) it pushes and opens the PR with the cycle
// App's installation token (OCTOPUSH_WEB_TOKEN), refuses the web's human-only
// paths, and for an `app-issue` job (an app-repo `area:web` issue) names
// `octopush-sh/octopush#N` in the PR and comments the link on that issue with
// GH_TOKEN. App-token pushes start the web repo's CI themselves (only
// GITHUB_TOKEN pushes don't), so nothing is dispatched there.
//
// Reads .agent-out/result.json:
//   { "action": "pr",     "title": "…", "summary": "…" }   new work for an issue
//   { "action": "update", "summary": "…" }                  fixes pushed to an existing PR
//   { "action": "stop",   "reason": "…" }                   can't build it safely — park for the owner
//
// Env: GH_TOKEN, OCTOPUSH_GIT_DIR (the checkout's .git, moved out of the agent's
// reach), OCTOPUSH_SECRETS (newline-separated values that must never be
// published — the Claude token), GITHUB_REPOSITORY.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { makeGh, ghForRepo, APP_REPO, WEB_REPO, labelsOf, sanitize, reportFatal } from "./gh.mjs";
import { humanOnlyFor } from "./automerge.mjs";

export const MAX_TITLE = 90;
export const MAX_TEXT = 6000;
/** Reference material a workflow puts next to the agent (the app's stable FEATURES.md…) — never committed. */
export const REF_DIR = ".agent-ref";
/** Paths an agent's change may not touch: every human-only path of the repo, plus the agent's own output, references and git. */
const forbiddenFor = (repo) => [...humanOnlyFor(repo), /^\.agent-out\//, /^\.agent-ref\//, /(^|\/)\.git(\/|$)/];
/** Caches the checks leave behind — never committed. */
// Build and test output, never committed: caches, and the JSON reports a test
// run leaves behind (#383 shipped a 2,500-test Vitest dump with runner paths).
export const CACHE = [
  /(^|\/)node_modules\//, /(^|\/)\.vite\//, /\.tsbuildinfo$/, /^coverage\//, /(^|\/)\.vitest/, /^dist\//, /(^|\/)\.astro\//,
  /(^|\/)vitest-report[^/]*\.json$/, /(^|\/)[^/]*\.tmp\.json$/, /(^|\/)junit[^/]*\.xml$/,
];
export const KINDS = ["issue", "pr", "app-issue"];
/** Marks a builder fix round on a PR (jobs.mjs counts them). */
export const UPDATE_MARK = "<!-- octopush-build:update -->";

/** Keep GitHub from treating agent text as closing other issues ("Closes #5"). */
export const defuseClosing = (text) =>
  String(text ?? "").replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(:?\s+)([\w.-]+\/[\w.-]+)?#(\d+)/gi,
    (_, k, sp, r, d) => `${k}${sp}${r ? `${r} ` : ""}issue ${d}`);

/** Shorten text to `max` chars at a word boundary, with an ellipsis (pure). */
export function fit(text, max) {
  const s = String(text).replace(/[ \t]+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Validate the agent's result.json for a job kind. Returns { result } or
 * { error }. Over-long text is shortened, not rejected — a night's work isn't
 * thrown away for a long title.
 */
export function parseResult(text, kind) {
  let r;
  try { r = JSON.parse(text); } catch { return { error: "result.json is not valid JSON" }; }
  if (!r || typeof r !== "object") return { error: "result.json must be an object" };
  r = { ...r };
  if (typeof r.title === "string") r.title = fit(r.title.split("\n")[0], MAX_TITLE);
  for (const k of ["summary", "reason"]) if (typeof r[k] === "string") r[k] = fit(r[k], MAX_TEXT);
  const str = (k, max) => typeof r[k] === "string" && r[k].trim().length > 0 && r[k].length <= max;
  if (r.action === "stop") return str("reason", MAX_TEXT) ? { result: r } : { error: "stop needs a reason" };
  if ((kind === "issue" || kind === "app-issue") && r.action === "pr") {
    if (!str("title", MAX_TITLE)) return { error: `pr needs a title (1–${MAX_TITLE} chars)` };
    if (!str("summary", MAX_TEXT)) return { error: "pr needs a summary" };
    return { result: r };
  }
  if (kind === "pr" && r.action === "update") return str("summary", MAX_TEXT) ? { result: r } : { error: "update needs a summary" };
  return { error: `action "${r.action}" is not valid for a${kind === "issue" ? "n issue" : " PR"} job` };
}

/** Does any text contain one of the secret values? */
export function leaks(texts, secrets) {
  const s = secrets.map((x) => x.trim()).filter((x) => x.length >= 8);
  return texts.some((t) => s.some((x) => t.includes(x)));
}

export const branchFor = (n, title, kind = "issue") =>
  `agent/${kind === "app-issue" ? "app-issue" : "issue"}-${n}-${title.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;

/** Paths an agent may not change in `repo` (pure). */
export const forbiddenPaths = (paths, repo = APP_REPO) => paths.filter((p) => forbiddenFor(repo).some((re) => re.test(p)));

/** The commit identity: the workflow's bot, or the App's bot in the web repo (OCTOPUSH_GIT_NAME/EMAIL). */
const botIdentity = (env = process.env) => {
  const name = /^[a-z0-9-]+\[bot\]$/i.test(env.OCTOPUSH_GIT_NAME ?? "") ? env.OCTOPUSH_GIT_NAME : "github-actions[bot]";
  const email = /^[0-9]+\+[a-z0-9-]+\[bot\]@users\.noreply\.github\.com$/i.test(env.OCTOPUSH_GIT_EMAIL ?? "") ? env.OCTOPUSH_GIT_EMAIL : "41898282+github-actions[bot]@users.noreply.github.com";
  return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
};
// Never run hooks, fsmonitor or filters from anything the agent could have written.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=never"];

function git(gitDir, args, opts = {}) {
  return execFileSync("git", [...SAFE, `--git-dir=${gitDir}`, `--work-tree=${process.cwd()}`, ...args], { encoding: "utf8", ...opts });
}

/**
 * Changed paths with their porcelain status (`XY`). With `-z`, a rename or
 * copy is followed by its original path as a separate entry; that one is kept
 * too (as a deletion), so the old name is staged as removed.
 */
export function parsePorcelain(out) {
  const parts = out.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i];
    if (!l) continue;
    const xy = l.slice(0, 2);
    entries.push({ xy, path: l.slice(3) });
    if (/[RC]/.test(xy) && parts[i + 1]) entries.push({ xy: " D", path: parts[++i] });
  }
  return entries;
}

function changedPaths(gitDir) {
  return parsePorcelain(git(gitDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

function park(gh, repo, kind, n, reason) {
  gh.send("POST", `repos/${repo}/issues/${n}/comments`, {
    body: `The nightly builder stopped and needs you:\n\n> ${sanitize(reason).replace(/\n/g, "\n> ")}\n\n<!-- octopush-build:stopped -->`,
  });
  gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["needs-owner"] });
  if (kind !== "pr") { try { gh.send("DELETE", `repos/${repo}/issues/${n}/labels/ready`); } catch { /* absent */ } }
}

async function main() {
  const [kind, num, existingBranch] = process.argv.slice(2);
  const n = Number(num);
  if (!KINDS.includes(kind) || !Number.isInteger(n)) { console.error("usage: publish-build.mjs <issue|pr|app-issue> <n> [branch]"); return 64; }
  const repo = process.env.OCTOPUSH_PUBLISH_REPO || process.env.GITHUB_REPOSITORY;
  const gitDir = process.env.OCTOPUSH_GIT_DIR;
  const web = repo === WEB_REPO;
  const token = web ? process.env.OCTOPUSH_WEB_TOKEN : process.env.GH_TOKEN;
  if (!repo || !gitDir || !token) throw new Error(`the repo, OCTOPUSH_GIT_DIR and ${web ? "OCTOPUSH_WEB_TOKEN" : "GH_TOKEN"} are required`);
  if (kind === "app-issue" && !web) throw new Error("app-issue jobs are built in octopush-web");
  if (web && !process.env.GH_TOKEN) throw new Error("GH_TOKEN (the app repo) is required for web jobs");
  // Every token-holding value must be scanned for, not only the Claude one.
  const secrets = (process.env.OCTOPUSH_SECRETS ?? "").split("\n");
  return publish({ kind, n, existingBranch, repo, gitDir, token, secrets, gh: ghForRepo(repo), appGh: makeGh() });
}

/**
 * The whole publishing flow, run in the current directory (the agent's
 * checkout). `pushUrl` is only for tests (a local bare repo).
 */
export async function publish({ kind, n, existingBranch, repo, gitDir, token, secrets, gh, appGh = gh, pushUrl }) {
  // Where the job's issue lives: an app-issue job's issue is in the app repo.
  const [jobGh, jobRepo] = kind === "app-issue" ? [appGh, APP_REPO] : [gh, repo];
  const file = join(".agent-out", "result.json");
  const parsed = existsSync(file) ? parseResult(readFileSync(file, "utf8"), kind) : { error: "the agent wrote no .agent-out/result.json" };
  rmSync(".agent-out", { recursive: true, force: true });
  rmSync(REF_DIR, { recursive: true, force: true });
  if (parsed.error) { park(jobGh, jobRepo, kind, n, `Its output was unusable: ${parsed.error}.`); return 1; }
  const r = parsed.result;
  if (r.action === "stop") { park(jobGh, jobRepo, kind, n, r.reason); console.log(`parked #${n}`); return 0; }

  // The path checks run on ALL changed paths first; caches are dropped only
  // after (the secret scan reads only what will be committed).
  const entries = changedPaths(gitDir);
  const all = entries.map((e) => e.path);
  if (!all.length) { park(jobGh, jobRepo, kind, n, "It reported success but changed no files."); return 1; }
  const bad = forbiddenPaths(all, repo);
  if (bad.length) { park(jobGh, jobRepo, kind, n, `It changed paths agents may not touch: ${bad.join(", ")}.`); return 1; }
  // A committed symlink could point the reviewer (or anyone) at /proc or runner files.
  const links = all.filter((p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } });
  if (links.length) { park(jobGh, jobRepo, kind, n, `It created symlinks, which agents may not commit: ${links.join(", ")}.`); return 1; }
  // A cache file is never added, but removing one that is already committed
  // (a report a past round shipped) must still reach the branch.
  const paths = entries
    .filter((e) => e.xy.includes("D") || !CACHE.some((re) => re.test(e.path)))
    .map((e) => e.path);
  if (!paths.length) { park(jobGh, jobRepo, kind, n, "It changed only cache files."); return 1; }
  const contents = paths.filter((p) => existsSync(p)).map((p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } });
  if (leaks([...contents, r.title ?? "", r.summary ?? ""], [...secrets, token])) {
    park(jobGh, jobRepo, kind, n, "Its output contained a secret value, so nothing was pushed. Look at the workflow run.");
    return 1;
  }

  const branch = kind === "pr" ? existingBranch : branchFor(n, r.title, kind);
  if (!branch) throw new Error("a PR job needs its branch");
  const closes = kind === "app-issue" ? `Closes ${APP_REPO}#${n}` : `Closes #${n}`;
  // Literal pathspecs from stdin: a file named "*" or ":(glob)**" is just a name.
  git(gitDir, ["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: paths.join("\0") });
  git(gitDir, [...botIdentity(), "commit", "--quiet", "--no-verify", "-m", kind === "pr" ? `Address review on #${n}` : `${r.title.slice(0, 72)}\n\n${closes}`]);
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  // The token reaches git through the environment, never argv (visible in the process table).
  const authEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}` };
  git(gitDir, [...(pushUrl ? ["-c", "protocol.file.allow=always"] : []),
    "push", "--quiet", ...(kind !== "pr" ? ["--force"] : []), pushUrl ?? `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`], { env: authEnv });

  const web = repo === WEB_REPO;
  const workflow = web ? "web-build.yml" : "nightly-build.yml";
  let prNumber = n;
  if (kind !== "pr") {
    const open = gh.list(`repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${branch}`);
    const decides = web ? "The web review judges it; the owner merges website PRs (merging publishes)" : "The nightly review decides";
    const body = `${closes}\n\n${defuseClosing(sanitize(r.summary))}\n\n---\n_Opened by the nightly builder (\`${workflow}\` in ${APP_REPO}). ${decides}; see docs/ROUTINES.md._`;
    const pr = open[0] ?? gh.send("POST", `repos/${repo}/pulls`, { title: defuseClosing(sanitize(r.title)), head: branch, base: "main", body });
    prNumber = pr.number;
    if (!labelsOf(pr).includes("agent")) gh.send("POST", `repos/${repo}/issues/${prNumber}/labels`, { labels: ["agent"] });
    const link = kind === "app-issue" ? `${repo}#${prNumber}${pr.html_url ? ` (${pr.html_url})` : ""}` : `#${prNumber}`;
    jobGh.send("POST", `repos/${jobRepo}/issues/${n}/comments`, { body: `Opened ${link} for this.` });
  } else {
    gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Pushed fixes:\n\n${defuseClosing(sanitize(r.summary))}\n\n${UPDATE_MARK}` });
  }
  // Pushes made with GITHUB_TOKEN don't start workflows: dispatch the app's CI
  // explicitly. App installation-token pushes (the web repo) start it on their own.
  if (!web) gh.send("POST", `repos/${repo}/actions/workflows/ci.yml/dispatches`, { ref: branch });
  console.log(`published ${kind} #${n} → ${web ? "web" : "PR "}#${prNumber} (${branch})`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { reportFatal("publish-build", e); process.exit(2); });
}
