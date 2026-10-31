// Tiny GitHub REST client over the `gh` CLI, shared by the Node routine scripts.
// The runner is injectable so tests never touch the network.
import { execFileSync } from "node:child_process";

export const OWNER = "octopush-sh";
export const APP_REPO = `${OWNER}/octopush`;
export const WEB_REPO = `${OWNER}/octopush-web`;
export const API_REPO = `${OWNER}/octopush-api`;
export const ALL_REPOS = [APP_REPO, API_REPO, WEB_REPO];

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

export function makeGh(run = ghRun) {
  const parse = (out) => (out && out.trim() ? JSON.parse(out) : null);
  const gh = {
    get: (path) => parse(run([path])),
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

export function ciStatus(gh, repo, sha) {
  const runs = (gh.get(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=50`)?.workflow_runs ?? [])
    .filter((r) => r.name === "CI" && !(r.status === "completed" && NON_VERDICT.includes(r.conclusion)) && r.status !== "waiting")
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const last = runs.at(-1);
  if (!last) return "none";
  if (last.status !== "completed") return "pending";
  return last.conclusion === "success" ? "success" : "failure";
}

export const labelsOf = (issueOrPr) => (issueOrPr.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));

/**
 * Make agent-written text safe to post: neutralise HTML comments, so text from
 * an agent can never carry a routine marker (`<!-- octopush-… -->`) — the
 * review verdicts, digest maps and applied-answer records are such markers.
 */
export const sanitize = (text) => String(text ?? "").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");

/**
 * Report a script's fatal error. In GitHub Actions it is also an annotation,
 * which shows on the run's summary page (and through the checks API) without
 * opening the logs.
 */
export function reportFatal(name, e) {
  const msg = String(e?.message ?? e);
  console.error(`${name}: ${msg}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    const one = msg.slice(0, 1500).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    console.log(`::error title=${name}::${one}`);
  }
}
