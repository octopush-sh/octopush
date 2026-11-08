#!/usr/bin/env node
// What failed in CI on a commit, for a builder's prompt (a PR sent back or red).
//
//   ci-failures.mjs <owner/repo> <sha>
//
// Uses the Actions API only (workflow runs, their jobs and the jobs' logs), which
// `actions: read` covers. The check-runs API would give annotations with a path
// and line, but it needs `checks: read`, which the "Octopush Cycle" App's
// installation doesn't grant (docs/ROUTINES.md): asking for it would make
// minting the web token fail outright, and calling it without it is a 403 —
// which, under `set -o pipefail`, killed every web-build PR run (web-build.yml).
//
// Never fatal: missing CI context must not stop a build. On any API error it
// prints UNAVAILABLE and exits 0. Log lines come from CI output of the agent's
// own branch: only `##[error]` lines, control characters stripped, capped.
import { ghForRepo, ALL_REPOS } from "./gh.mjs";

export const UNAVAILABLE = "(CI checks unavailable)";
export const NONE = "(none)";
export const MAX_JOBS = 5;
export const MAX_LINES = 40;
export const MAX_LINE = 300;
const FAILED = ["failure", "timed_out"];

/** The `##[error]` lines of a job log, cleaned and capped (the exit-code line is noise). */
export function errorLines(log, max = MAX_LINES) {
  const out = [];
  for (const raw of String(log ?? "").split("\n")) {
    const i = raw.indexOf("##[error]");
    if (i < 0) continue;
    const line = raw.slice(i + "##[error]".length)
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .trim();
    if (!line || /^Process completed with exit code \d+\.?$/.test(line)) continue;
    out.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    if (out.length >= max) break;
  }
  return out;
}

/** The latest run of each workflow for `sha` that failed. */
export function failedRuns(runs) {
  const latest = new Map();
  for (const r of runs ?? []) {
    const k = r.workflow_id ?? r.name;
    const cur = latest.get(k);
    if (!cur || cur.created_at < r.created_at) latest.set(k, r);
  }
  return [...latest.values()].filter((r) => r.status === "completed" && FAILED.includes(r.conclusion));
}

/**
 * Markdown lines describing the failing runs/jobs/steps on `sha`, or NONE.
 * `gh` is a makeGh client; listing errors propagate (the caller says UNAVAILABLE),
 * a single unreadable job log does not.
 */
export function ciFailures(gh, repo, sha) {
  const runs = failedRuns(gh.get(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)?.workflow_runs);
  if (!runs.length) return NONE;
  const out = [];
  let jobs = 0;
  for (const run of runs) {
    const failed = (gh.get(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)?.jobs ?? [])
      .filter((j) => FAILED.includes(j.conclusion));
    if (!failed.length) { out.push(`- ${run.name}: ${run.conclusion}`); continue; }
    for (const job of failed) {
      if (jobs++ >= MAX_JOBS) { out.push(`- (more failing jobs omitted)`); return out.join("\n"); }
      out.push(`- ${run.name} / ${job.name}: ${job.conclusion}`);
      for (const s of job.steps ?? []) if (FAILED.includes(s.conclusion)) out.push(`  - step failed: ${s.name}`);
      let lines;
      try { lines = errorLines(gh.raw(`repos/${repo}/actions/jobs/${job.id}/logs`)); } catch { lines = null; }
      if (lines === null) out.push("  - (log unavailable)");
      else for (const l of lines) out.push(`  - ${l}`);
    }
  }
  return out.join("\n");
}

function main() {
  const [repo, sha] = process.argv.slice(2);
  if (!ALL_REPOS.includes(repo) || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("usage: ci-failures.mjs <cycle owner/repo> <40-hex sha>");
    return 64;
  }
  try {
    console.log(ciFailures(ghForRepo(repo), repo, sha));
  } catch (e) {
    console.log(UNAVAILABLE);
    const msg = String(e?.stderr || e?.message || e).trim().split("\n")[0].slice(0, 300);
    console.error(`ci-failures: ${msg}`);
    if (process.env.GITHUB_ACTIONS === "true") console.log(`::warning title=ci-failures::CI checks unavailable for the prompt (${msg.replace(/[%\r\n:,]/g, " ")})`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
