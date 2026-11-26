// Tiny GitHub REST client over the `gh` CLI, shared by the Node routine scripts.
// The runner is injectable so tests never touch the network.
import { execFileSync } from "node:child_process";

export const OWNER = "octopush-sh";
export const APP_REPO = `${OWNER}/octopush`;
export const WEB_REPO = `${OWNER}/octopush-web`;
export const API_REPO = `${OWNER}/octopush-api`;
export const ALL_REPOS = [APP_REPO, API_REPO, WEB_REPO];
/**
 * Epiku: a PRIVATE repo with its own lane (epiku-build.yml, epiku-review.yml).
 * Deliberately not in ALL_REPOS: the digest, the report and the audits walk
 * that list and print titles in this public repo.
 */
export const EPIKU_REPO = `${OWNER}/epiku`;
/**
 * The repos the cycle reaches as the "Octopush Cycle" GitHub App, and the
 * variable that carries each one's installation token. One variable per repo,
 * so a step never holds a token for a repo it wasn't given.
 */
const APP_TOKEN_ENV = { [WEB_REPO]: "OCTOPUSH_WEB_TOKEN", [EPIKU_REPO]: "OCTOPUSH_EPIKU_TOKEN" };
export const tokenEnvFor = (repo) => (Object.hasOwn(APP_TOKEN_ENV, repo) ? APP_TOKEN_ENV[repo] : null);
/** Private repos: nothing but numbers and commit ids of theirs may reach this public repo's logs. */
export const isPrivateLane = (repo) => repo === EPIKU_REPO;

/** Default runner: `gh api ...` → stdout. Throws on non-zero exit. */
export function ghRun(args, input, token) {
  return execFileSync("gh", ["api", ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
  });
}

/** A runner that authenticates with `token` instead of the default gh login. */
export const ghRunAs = (token) => (args, input) => ghRun(args, input, token);

/**
 * The client for a repo. In GitHub Actions the workflow's GITHUB_TOKEN (GH_TOKEN)
 * only reaches the app repo; octopush-web and epiku are reached with a
 * short-lived installation token of the "Octopush Cycle" GitHub App
 * (OCTOPUSH_WEB_TOKEN, OCTOPUSH_EPIKU_TOKEN: one per repo, never shared),
 * which fixed workflow steps mint and never hand to an agent. Without it, the
 * default login is used (on a Mac, the owner's `gh` setup).
 */
export function ghForRepo(repo, env = process.env) {
  const key = tokenEnvFor(repo);
  if (key && env[key]) return makeGh(ghRunAs(env[key]));
  // Epiku is private: in Actions the workflow's own token can't see it, and
  // falling back to it would only turn a missing token into a confusing 404.
  if (repo === EPIKU_REPO && env.GITHUB_ACTIONS === "true") throw new Error(`${key} is not set: ${EPIKU_REPO} is reached only with the Octopush Cycle App's installation token`);
  return makeGh();
}
/** Is octopush-web reachable with its own token in this process? */
export const hasWebToken = (env = process.env) => !!env.OCTOPUSH_WEB_TOKEN;

export function makeGh(run = ghRun) {
  const parse = (out) => (out && out.trim() ? JSON.parse(out) : null);
  const gh = {
    get: (path) => parse(run([path])),
    /** GET a non-JSON body as text (e.g. a job's log). */
    raw: (path) => run([path]),
    /** GET every page of a list endpoint (per_page=100), up to `max` items. */
    list(path, max = 1000) {
      const sep = path.includes("?") ? "&" : "?";
      const items = [];
      for (let page = 1; items.length < max; page++) {
        const batch = parse(run([`${path}${sep}per_page=100&page=${page}`])) ?? [];
        const arr = Array.isArray(batch) ? batch : batch.items ?? batch.workflow_runs ?? [];
        items.push(...arr);
        if (arr.length < 100) break;
      }
      return items.slice(0, max);
    },
    /** POST/PATCH/PUT/DELETE with a JSON body. */
    send(method, path, body) {
      return parse(run(["-X", method, path, "--input", "-"], JSON.stringify(body ?? {})));
    },
    viewer: () => gh.get("user").login,
  };
  return gh;
}

/** success | pending | failure | none — latest "CI" workflow run for a commit. */
/**
 * Run outcomes that say nothing about the code: a bot's pull_request run
 * waiting for approval ("action_required"), a run superseded by a newer one
 * ("cancelled"), skipped or stale runs. They're ignored.
 */
export const NON_VERDICT = ["action_required", "cancelled", "skipped", "stale", "neutral"];

/** The newest "CI" run for a commit that says something about the code, or null. */
export function latestCiRun(gh, repo, sha) {
  return (gh.get(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`)?.workflow_runs ?? [])
    .filter((r) => r.name === "CI" && !(r.status === "completed" && NON_VERDICT.includes(r.conclusion)) && r.status !== "waiting")
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).at(-1) ?? null;
}

export function ciStatus(gh, repo, sha) {
  const last = latestCiRun(gh, repo, sha);
  if (!last) return "none";
  if (last.status !== "completed") return "pending";
  return last.conclusion === "success" ? "success" : "failure";
}

/** First-parent commits of main looked at when its head has no verdict yet (a merge whose CI is running). */
export const MAIN_LOOKBACK = 5;
const FAILED_JOB = ["failure", "timed_out", "startup_failure"];

/** Has a still-running CI run on `sha` already failed a job? (ci.yml starts the builder from inside that run.) */
function failingWhileRunning(gh, repo, sha) {
  const run = latestCiRun(gh, repo, sha);
  if (!run || run.status === "completed") return false;
  return (gh.get(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)?.jobs ?? []).some((j) => FAILED_JOB.includes(j.conclusion));
}

/**
 * main's CI: `{ state, sha, redSha }`. `state` is
 *   green   — the newest verdict on main's first-parent line is a pass;
 *   red     — it is a failure (`redSha` is the commit it failed on), or a job of
 *             the head's running CI has already failed;
 *   unknown — no verdict on the last MAIN_LOOKBACK commits (nothing pauses).
 * A head whose CI is still running or never ran (a release merge) inherits the
 * verdict of its first parent, so "red" lasts until a newer commit is green.
 * API errors propagate: each caller decides what "can't tell" means.
 */
export function mainCi(gh, repo = APP_REPO) {
  let ref = "main";
  let head = null;
  for (let i = 0; i < MAIN_LOOKBACK; i++) {
    const c = gh.get(`repos/${repo}/commits/${ref}`);
    if (!c?.sha) break;
    head ??= c.sha;
    const st = ciStatus(gh, repo, c.sha);
    if (st === "success") return { state: "green", sha: head, redSha: null };
    if (st === "failure") return { state: "red", sha: head, redSha: c.sha };
    if (st === "pending" && failingWhileRunning(gh, repo, c.sha)) return { state: "red", sha: head, redSha: c.sha };
    ref = c.parents?.[0]?.sha;
    if (!ref) break;
  }
  return { state: "unknown", sha: head, redSha: null };
}

export const labelsOf = (issueOrPr) => (issueOrPr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));

/**
 * Make agent-written text safe to post: neutralise HTML comments, so text from
 * an agent can never carry a routine marker (`<!-- octopush-… -->`) — the
 * review verdicts, digest maps and applied-answer records are such markers.
 */
export const sanitize = (text) => String(text ?? "").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");

/**
 * Private lanes (epiku): an error's message is never printed. A failed command's
 * message carries its command line and its stderr, a JSON parse error quotes
 * the text it choked on — and this repo's log is public. Only a fixed reason
 * code leaves: the HTTP status or exit status, or the text of an error made
 * with `safeError` (written here, with nothing of the private repo in it).
 * On for the whole process once a script learns its repo is private
 * (`markPrivate`), or from the workflow (OCTOPUSH_QUIET_ERRORS=1).
 */
export const quietErrors = (env = process.env) => env.OCTOPUSH_QUIET_ERRORS === "1";
export function markPrivate(repo, env = process.env) { if (isPrivateLane(repo)) env.OCTOPUSH_QUIET_ERRORS = "1"; }
export const safeError = (msg) => Object.assign(new Error(msg), { safe: true });
export function quietMessage(e) {
  if (e?.safe === true) return String(e.message);
  const http = /\(HTTP (\d{3})\)/.exec(String(e?.stderr ?? "") + String(e?.message ?? ""))?.[1];
  const code = http ? `HTTP ${http}` : Number.isInteger(e?.status) ? `exit ${e.status}` : /^E[A-Z0-9]{2,12}$/.test(e?.code ?? "") ? e.code : "error";
  return `failed (${code}); details withheld from this public log`;
}

/**
 * Report a script's fatal error. In GitHub Actions it is also an annotation,
 * which shows on the run's summary page (and through the checks API) without
 * opening the logs.
 */
export function reportFatal(name, e) {
  const msg = quietErrors() ? quietMessage(e) : String(e?.message ?? e);
  console.error(`${name}: ${msg}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    const one = msg.slice(0, 1500).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::error title=${name}::${one}`);
  }
}
