#!/usr/bin/env node
// Publish what a nightly builder agent produced (docs/ROUTINES.md, nightly-build.yml).
// Runs AFTER the agent, from a copy of scripts/routines taken before it started,
// with the workflow's GITHUB_TOKEN. The agent itself never touches GitHub.
//
//   publish-build.mjs <issue|pr> <number> [branch]
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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeGh, labelsOf, sanitize } from "./gh.mjs";

export const MAX_TITLE = 90;
export const MAX_TEXT = 6000;
/** Paths an agent's change may not touch (the token can't push workflows anyway). */
const FORBIDDEN = [/^\.github\//, /^\.agent-out\//, /^\.git(\/|$)/];

/** Validate the agent's result.json for a job kind. Returns { result } or { error }. */
export function parseResult(text, kind) {
  let r;
  try { r = JSON.parse(text); } catch { return { error: "result.json is not valid JSON" }; }
  if (!r || typeof r !== "object") return { error: "result.json must be an object" };
  const str = (k, max) => typeof r[k] === "string" && r[k].trim().length > 0 && r[k].length <= max;
  if (r.action === "stop") return str("reason", MAX_TEXT) ? { result: r } : { error: "stop needs a reason" };
  if (kind === "issue" && r.action === "pr") {
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

export const branchFor = (n, title) =>
  `agent/issue-${n}-${title.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;

/** Paths an agent may not change (pure). */
export const forbiddenPaths = (paths) => paths.filter((p) => FORBIDDEN.some((re) => re.test(p)));

const BOT = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];
// Never run hooks, fsmonitor or filters from anything the agent could have written.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=never"];

function git(gitDir, args, opts = {}) {
  return execFileSync("git", [...SAFE, `--git-dir=${gitDir}`, `--work-tree=${process.cwd()}`, ...args], { encoding: "utf8", ...opts });
}

function changedPaths(gitDir) {
  return git(gitDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    .split("\0").filter(Boolean)
    .map((l) => l.slice(3));
}

function park(gh, repo, kind, n, reason) {
  gh.send("POST", `repos/${repo}/issues/${n}/comments`, {
    body: `The nightly builder stopped and needs you:\n\n> ${sanitize(reason).replace(/\n/g, "\n> ")}\n\n<!-- octopush-build:stopped -->`,
  });
  gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["needs-owner"] });
  if (kind === "issue") { try { gh.send("DELETE", `repos/${repo}/issues/${n}/labels/ready`); } catch { /* absent */ } }
}

async function main() {
  const [kind, num, existingBranch] = process.argv.slice(2);
  const n = Number(num);
  if (!["issue", "pr"].includes(kind) || !Number.isInteger(n)) { console.error("usage: publish-build.mjs <issue|pr> <n> [branch]"); return 64; }
  const repo = process.env.GITHUB_REPOSITORY;
  const gitDir = process.env.OCTOPUSH_GIT_DIR;
  const token = process.env.GH_TOKEN;
  if (!repo || !gitDir || !token) throw new Error("GITHUB_REPOSITORY, OCTOPUSH_GIT_DIR and GH_TOKEN are required");
  const secrets = (process.env.OCTOPUSH_SECRETS ?? "").split("\n");
  const gh = makeGh();

  const file = join(".agent-out", "result.json");
  const parsed = existsSync(file) ? parseResult(readFileSync(file, "utf8"), kind) : { error: "the agent wrote no .agent-out/result.json" };
  rmSync(".agent-out", { recursive: true, force: true });
  if (parsed.error) { park(gh, repo, kind, n, `Its output was unusable: ${parsed.error}.`); return 1; }
  const r = parsed.result;
  if (r.action === "stop") { park(gh, repo, kind, n, r.reason); console.log(`parked #${n}`); return 0; }

  const paths = changedPaths(gitDir);
  if (!paths.length) { park(gh, repo, kind, n, "It reported success but changed no files."); return 1; }
  const bad = forbiddenPaths(paths);
  if (bad.length) { park(gh, repo, kind, n, `It changed paths agents may not touch: ${bad.join(", ")}.`); return 1; }
  const contents = paths.filter((p) => existsSync(p)).map((p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } });
  if (leaks([...contents, r.title ?? "", r.summary ?? ""], secrets)) {
    park(gh, repo, kind, n, "Its output contained a secret value, so nothing was pushed. Look at the workflow run.");
    return 1;
  }

  const branch = kind === "pr" ? existingBranch : branchFor(n, r.title);
  if (!branch) throw new Error("a PR job needs its branch");
  git(gitDir, ["add", "-A", "--", "."]);
  git(gitDir, [...BOT, "commit", "--quiet", "--no-verify", "-m", kind === "pr" ? `Address review on #${n}` : `${r.title.slice(0, 72)}\n\nCloses #${n}`]);
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  git(gitDir, ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, "push", "--quiet",
    ...(kind === "issue" ? ["--force"] : []), `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`]);

  let prNumber = n;
  if (kind === "issue") {
    const open = gh.list(`repos/${repo}/pulls?state=open&head=${repo.split("/")[0]}:${branch}`);
    const body = `Closes #${n}\n\n${sanitize(r.summary)}\n\n---\n_Opened by the nightly builder (\`nightly-build.yml\`). The nightly review decides; see docs/ROUTINES.md._`;
    const pr = open[0] ?? gh.send("POST", `repos/${repo}/pulls`, { title: sanitize(r.title), head: branch, base: "main", body });
    prNumber = pr.number;
    if (!labelsOf(pr).includes("agent")) gh.send("POST", `repos/${repo}/issues/${prNumber}/labels`, { labels: ["agent"] });
    gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Opened #${prNumber} for this.` });
  } else {
    gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Pushed fixes:\n\n${sanitize(r.summary)}` });
  }
  // Pushes made with GITHUB_TOKEN don't start workflows; dispatch CI explicitly.
  gh.send("POST", `repos/${repo}/actions/workflows/ci.yml/dispatches`, { ref: branch });
  console.log(`published ${kind} #${n} → PR #${prNumber} (${branch})`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`publish-build: ${e.message}`); process.exit(2); });
}
