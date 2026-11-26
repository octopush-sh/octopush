#!/usr/bin/env node
// What failed in CI on a commit, for a builder's prompt (a PR sent back or red)
// and for the cycle's "main is red" issue (main-health.mjs).
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
// Runs only in a fixed workflow step, with the workflow's token; an agent never
// fetches a log. Per failed job it reports the failing step, the first error
// lines (`##[error]` and the compiler/test-runner lines that say what broke:
// rustc, tsc, Vitest, node:test, panics), the failing test names, and — when no
// such line exists — the last lines of the log before the step failed. Every
// line is cleaned of control/invisible characters, capped, and redacted (known
// secret values, credential shapes, anything that looks like a key); the whole
// report is bounded and fenced as untrusted data.
//
// Never fatal: missing CI context must not stop a build. On any API error it
// prints UNAVAILABLE and exits 0 (diagnostics go to stderr, never into the
// prompt).
import { ghForRepo, ALL_REPOS, EPIKU_REPO, NON_VERDICT, markPrivate, quietErrors, quietMessage } from "./gh.mjs";
import { fence, SECRET_PATTERNS, secretValues } from "./social.mjs";

export const UNAVAILABLE = "(CI checks unavailable)";
export const NONE = "(none)";
export const MAX_JOBS = 5;
export const MAX_LINES = 40;
export const MAX_LINE = 300;
export const MAX_TESTS = 30;
export const TAIL_LINES = 20;
/** The whole report, in characters: a log can't crowd the job out of the prompt. */
export const MAX_REPORT = 12000;
const FAILED = ["failure", "timed_out", "startup_failure"];
export const FENCE_LABEL = "failing CI on this commit: workflow, job and step names and error lines from its CI logs, which the branch's own code produced";

/**
 * Drop what could hide or reorder text from a reader: ANSI CSI and OSC
 * sequences (and any leftover ESC), C0/C1 controls, zero-width characters,
 * bidi embeddings/overrides/isolates and the BOM.
 */
export const clean = (s) => String(s ?? "")
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
  .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
  .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
  .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
  .replace(/ {2,}/g, " ");

const cap = (line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
const EXIT_LINE = /^Process completed with exit code \d+\.?$/;

/** The `##[error]` lines of a job log, cleaned and capped (the exit-code line is noise). */
export function errorLines(log, max = MAX_LINES) {
  const out = [];
  for (const raw of String(log ?? "").split("\n")) {
    const i = raw.indexOf("##[error]");
    if (i < 0) continue;
    const line = clean(raw.slice(i + "##[error]".length)).trim();
    if (!line || EXIT_LINE.test(line)) continue;
    out.push(cap(line));
    if (out.length >= max) break;
  }
  return out;
}

// ------------------------------------------------------------------ the log's own words

/** Each log line without its runner timestamp, cleaned. */
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const logLines = (log) => String(log ?? "").split("\n").map((l) => clean(l.replace(STAMP, "")).trim());

/**
 * Lines that say what broke. `next` also keeps the line after (a panic's
 * message); `block` keeps the lines after it up to the next blank line, at most
 * BLOCK_LINES (rustc's location, the code and its labels).
 */
const BLOCK_LINES = 12;
const NEXT_DIAGNOSTIC = /^(error|warning)(\[\w+\])?: /;
const ERROR_LINE = [
  { re: /^error(\[E\d{4}\])?: /, block: true },             // rustc / cargo
  { re: /^thread '.*' panicked at /, next: /\S/ },        // a Rust test's panic, then its message
  { re: /\berror TS\d{4,5}: / },                          // tsc
  { re: /^(FAIL|×|✗|✖) \S/ },                             // Vitest, node:test
  { re: /^(\w*Error)(\s*\[[A-Z_]+\])?: / },               // JS errors and assertions
  { re: /^(left|right): / },                              // assert_eq!
  { re: /^npm (ERR!|error) / },
  { re: /^not ok \d+ / },                                 // node --test (TAP)
  { re: /^test \S+ \.\.\. FAILED$/ },
];
/** Failing test names, by runner. */
const TEST_NAME = [
  /^test (\S+) \.\.\. FAILED$/,                             // cargo test
  /^FAIL (\S.*?)$/,                                         // Vitest: FAIL src/a.test.ts > suite > name
  /^(?:×|✗) (\S.*?)(?: \d+(?:\.\d+)? ?m?s)?$/,              // Vitest's reporter
  /^not ok \d+ - (\S.*?)(?: #.*)?$/,                        // node --test (TAP)
  /^✖ (\S.*?)(?: \(\d+(?:\.\d+)?m?s\))?$/,                  // node --test (spec)
];

/**
 * What a job's log says about its failure (pure): `errors` (the `##[error]`
 * lines and the first error lines of the tools, in log order, deduplicated),
 * `tests` (failing test names) and `tail` (the last lines before the step
 * failed, only when nothing else was found). All cleaned and capped.
 */
export function logSummary(log, { maxLines = MAX_LINES, maxTests = MAX_TESTS, tailLines = TAIL_LINES } = {}) {
  const lines = logLines(log);
  const errors = [];
  const tests = [];
  const seen = new Set();
  // A diagnostic's own lines (its code, its `|` rulers) are kept as they are; a repeated headline isn't.
  const keep = (l, dedupe = true) => { const c = cap(l); if (!c || (dedupe && seen.has(c)) || errors.length >= maxLines) return; seen.add(c); errors.push(c); };
  let failedAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const at = l.indexOf("##[error]");
    if (at >= 0) {
      const msg = l.slice(at + "##[error]".length).trim();
      if (EXIT_LINE.test(msg)) { if (failedAt < 0) failedAt = i; continue; }
      if (msg.replace(/['"]/g, "").trim()) keep(msg);
      continue;
    }
    if (l.startsWith("##[")) continue; // groups, commands: the runner's, not the tools'
    for (const re of TEST_NAME) {
      const m = re.exec(l);
      if (m && tests.length < maxTests && !tests.includes(m[1])) tests.push(cap(m[1]));
    }
    const hit = ERROR_LINE.find((p) => p.re.test(l));
    if (!hit) continue;
    keep(l);
    if (hit.block) {
      for (let j = i + 1; j < lines.length && j <= i + BLOCK_LINES && lines[j] && !lines[j].startsWith("##[") && !NEXT_DIAGNOSTIC.test(lines[j]); j++) keep(lines[j], false);
    } else if (hit.next) {
      const after = lines[i + 1] ?? "";
      if (hit.next.test(after) && !after.startsWith("##[")) keep(after);
    }
  }
  let tail = [];
  if (!errors.length && !tests.length) {
    const end = failedAt >= 0 ? failedAt : lines.length;
    tail = lines.slice(0, end).filter((l) => l && !l.startsWith("##[")).slice(-tailLines).map(cap);
  }
  return { errors, tests, tail };
}

// ------------------------------------------------------------------ redaction

export const REDACTED = "[redacted]";
const global = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
const KEYWORD = "token|secret|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|credentials?";

/**
 * Replace anything that could be a credential with REDACTED (pure).
 * Conservative on purpose — a lost commit id costs nothing, a leaked key does:
 * the known secret `values` (plain and base64), the credential shapes of
 * social.mjs (SECRET_PATTERNS), a basic/bearer header, a URL's user:password,
 * the value of an UPPER_CASE variable whose name says token/secret/password/key,
 * an opaque value (digits in it) after a lower-case such name, and any run of
 * 40+ base64/URL-safe characters that mixes upper case, lower case and digits.
 */
export function redact(text, values = []) {
  let s = String(text ?? "");
  const known = [...new Set(values.map((v) => String(v ?? "").trim()).filter((v) => v.length >= 8))].sort((a, b) => b.length - a.length);
  for (const v of known) for (const form of [v, Buffer.from(v).toString("base64")]) s = s.split(form).join(REDACTED);
  for (const re of SECRET_PATTERNS) s = s.replace(global(re), REDACTED);
  s = s.replace(/\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${REDACTED}`);
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
  s = s.replace(new RegExp(`\\b([A-Z0-9_]*(?:${KEYWORD.toUpperCase()})[A-Z0-9_]*)=(?!\\[redacted\\])\\S+`, "g"), `$1=${REDACTED}`);
  s = s.replace(new RegExp(`\\b([\\w-]*(?:${KEYWORD}))(["']?\\s*[:=]\\s*["']?)([A-Za-z0-9_\\-+/=.~]{12,})`, "gi"),
    (m, k, sep, v) => (/\d/.test(v) && v !== REDACTED ? `${k}${sep}${REDACTED}` : m));
  s = s.replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? REDACTED : m));
  return s;
}

// ------------------------------------------------------------------ the report

/**
 * The latest run of each workflow for `sha` that failed. Like gh.mjs ciStatus,
 * runs that say nothing about the code (NON_VERDICT, waiting, not finished)
 * are dropped first, so they never mask an earlier verdict.
 */
export function failedRuns(runs) {
  const latest = new Map();
  for (const r of runs ?? []) {
    if (r.status !== "completed" || NON_VERDICT.includes(r.conclusion)) continue;
    const k = r.workflow_id ?? r.name;
    const cur = latest.get(k);
    if (!cur || cur.created_at < r.created_at) latest.set(k, r);
  }
  return [...latest.values()].filter((r) => FAILED.includes(r.conclusion));
}

/** What goes in the prompt: a fixed note, or the report fenced as untrusted data. */
export const forPrompt = (report) => (report === NONE || report === UNAVAILABLE ? report : fence(report, FENCE_LABEL));

/**
 * The failing runs/jobs on `sha`, structured: `[{ workflow, job, conclusion,
 * steps, errors, tests, tail, log }]` (`job` null for a run without a failed
 * job; `{ more: true }` once MAX_JOBS is reached; `log` false when a job's log
 * couldn't be read). Listing errors propagate (the caller says UNAVAILABLE), a
 * single unreadable job log does not. `gh` is a makeGh client.
 */
export function ciFailureList(gh, repo, sha) {
  const runs = failedRuns(gh.get(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)?.workflow_runs);
  const out = [];
  let jobs = 0;
  for (const run of runs) {
    const failed = (gh.get(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)?.jobs ?? [])
      .filter((j) => FAILED.includes(j.conclusion));
    if (!failed.length) { out.push({ workflow: clean(run.name), job: null, conclusion: run.conclusion }); continue; }
    for (const job of failed) {
      if (jobs++ >= MAX_JOBS) { out.push({ more: true }); return out; }
      let summary = null;
      try { summary = logSummary(gh.raw(`repos/${repo}/actions/jobs/${job.id}/logs`)); } catch { summary = null; }
      out.push({
        workflow: clean(run.name), job: clean(job.name), conclusion: job.conclusion,
        steps: (job.steps ?? []).filter((s) => FAILED.includes(s.conclusion)).map((s) => clean(s.name)),
        log: summary !== null, ...(summary ?? { errors: [], tests: [], tail: [] }),
      });
    }
  }
  return out;
}

/** The Markdown report for a ciFailureList, redacted and bounded, or NONE (pure but for the env's secrets). */
export function formatFailures(list, { secrets = secretValues() } = {}) {
  if (!list.length) return NONE;
  const out = [];
  for (const f of list) {
    if (f.more) { out.push("- (more failing jobs omitted)"); break; }
    if (!f.job) { out.push(`- ${f.workflow}: ${f.conclusion}`); continue; }
    out.push(`- ${f.workflow} / ${f.job}: ${f.conclusion}`);
    for (const s of f.steps ?? []) out.push(`  - step failed: ${s}`);
    if (f.log === false) { out.push("  - (log unavailable)"); continue; }
    for (const t of f.tests ?? []) out.push(`  - failing test: ${t}`);
    for (const l of f.errors ?? []) out.push(`  - ${l}`);
    if (f.tail?.length) { out.push("  - last lines of the log before the step failed:"); for (const l of f.tail) out.push(`    - ${l}`); }
  }
  let report = redact(out.join("\n"), secrets);
  if (report.length > MAX_REPORT) report = `${report.slice(0, report.lastIndexOf("\n", MAX_REPORT) > 0 ? report.lastIndexOf("\n", MAX_REPORT) : MAX_REPORT)}\n- (truncated)`;
  return report;
}

/** Markdown lines describing the failing runs/jobs/steps on `sha`, or NONE. */
export const ciFailures = (gh, repo, sha, opts) => formatFailures(ciFailureList(gh, repo, sha), opts);

function main() {
  const [repo, sha] = process.argv.slice(2);
  if (![...ALL_REPOS, EPIKU_REPO].includes(repo) || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("usage: ci-failures.mjs <cycle owner/repo> <40-hex sha>");
    return 64;
  }
  markPrivate(repo);
  try {
    console.log(forPrompt(ciFailures(ghForRepo(repo), repo, sha)));
  } catch (e) {
    console.log(UNAVAILABLE);
    // A private repo: a fixed code, never the command's own words.
    const msg = quietErrors() ? quietMessage(e) : String(e?.stderr || e?.message || e).trim().split("\n")[0].slice(0, 300);
    console.error(`ci-failures: ${msg}`);
    // stderr: stdout is the prompt; Actions reads workflow commands from both.
    if (process.env.GITHUB_ACTIONS === "true") console.error(`::warning title=ci-failures::CI checks unavailable for the prompt (${msg.replace(/[%\r\n:,]/g, " ")})`);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
