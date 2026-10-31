import { reportFatal, WEB_REPO } from "./gh.mjs";
// Who is who in the nightly cycle (VISION.md §8, docs/ROUTINES.md).
//
//   owner     — the human. Only their comments count as answers; never used by routines.
//   builder   — the account agent PRs are opened as.
//   reviewer  — the account review verdicts, merges, digests and answers are posted as.
//
// In GitHub Actions (the normal setup) builder and reviewer are both
// `github-actions[bot]`: the workflow's GITHUB_TOKEN. They may share a login
// there because no agent ever holds that token — agents run without any GitHub
// credential and write only files; fixed workflow steps read those files and do
// every GitHub write, and they neutralise markers in agent text (gh.mjs
// `sanitize`), so an agent can't forge a review verdict. The owner must always
// be a different account.
//
// In octopush-web the cycle acts as the "Octopush Cycle" GitHub App instead
// (OCTOPUSH_APP_BOT_LOGIN, e.g. `octopush-cycle[bot]`): its installation token
// is the only credential that reaches that private repo, so there the App's bot
// is both builder and reviewer (`idsForRepo`). Same reasoning: no agent ever
// holds its token.
//
// On a Mac (the earlier setup) all three must differ: two bot accounts, the
// builder as the default `gh` login and the reviewer's token in the Keychain.
//
// Configuration: environment variables, or ~/.config/octopush-routines/identity.env:
//   OCTOPUSH_OWNER_LOGIN=…   OCTOPUSH_BUILDER_LOGIN=…   OCTOPUSH_REVIEWER_LOGIN=…
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const FILE = join(homedir(), ".config", "octopush-routines", "identity.env");

/** The login of a workflow's GITHUB_TOKEN. */
export const ACTIONS_BOT = "github-actions[bot]";
export const inActions = (env = process.env) => env.GITHUB_ACTIONS === "true";
/** A GitHub App's bot login (`name[bot]`): never a person's account. */
export const isBotLogin = (login) => /^[a-z0-9-]+\[bot\]$/i.test(login ?? "");

export function loadIdentities(env = process.env, file = FILE) {
  const fromFile = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(OCTOPUSH_(?:OWNER|BUILDER|REVIEWER)_LOGIN)\s*=\s*"?([A-Za-z0-9-]+(?:\[bot\])?)"?\s*$/.exec(line);
      if (m) fromFile[m[1]] = m[2];
    }
  }
  const get = (k) => env[k] || fromFile[k] || "";
  const bot = inActions(env) ? ACTIONS_BOT : "";
  return {
    owner: get("OCTOPUSH_OWNER_LOGIN"),
    builder: get("OCTOPUSH_BUILDER_LOGIN") || bot,
    reviewer: get("OCTOPUSH_REVIEWER_LOGIN") || bot,
  };
}

/**
 * Throws unless all three logins are set, the owner differs from both bots,
 * and — outside GitHub Actions — builder and reviewer differ too.
 */
export function requireIdentities(ids, env = process.env) {
  const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`identities not configured: ${missing.join(", ")} (see docs/ROUTINES.md)`);
  if (sameLogin(ids.owner, ids.builder) || sameLogin(ids.owner, ids.reviewer)) {
    throw new Error("the owner's account can never be the builder or the reviewer");
  }
  const shared = sameLogin(ids.builder, ids.reviewer);
  if (shared && !(inActions(env) && isBotLogin(ids.builder))) {
    throw new Error("outside GitHub Actions, builder and reviewer must be two different GitHub accounts");
  }
  return ids;
}

export const sameLogin = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The identities that act in `repo`. For octopush-web in GitHub Actions that's
 * the GitHub App's bot (OCTOPUSH_APP_BOT_LOGIN) as builder and reviewer; the
 * owner is the same person everywhere. Elsewhere, `ids` unchanged.
 */
export function idsForRepo(ids, repo, env = process.env) {
  const bot = env.OCTOPUSH_APP_BOT_LOGIN;
  if (repo !== WEB_REPO || !inActions(env) || !bot) return ids;
  if (!isBotLogin(bot)) throw new Error(`OCTOPUSH_APP_BOT_LOGIN must be an App bot login (name[bot]), got ${bot}`);
  if (sameLogin(bot, ids.owner)) throw new Error("the owner's account can never be the builder or the reviewer");
  return { ...ids, builder: bot, reviewer: bot };
}

/** The reviewer's token: env OCTOPUSH_REVIEWER_TOKEN, else the macOS Keychain. */
export function reviewerToken(env = process.env) {
  if (env.OCTOPUSH_REVIEWER_TOKEN) return env.OCTOPUSH_REVIEWER_TOKEN;
  if (inActions(env) && (env.GH_TOKEN || env.GITHUB_TOKEN)) return env.GH_TOKEN || env.GITHUB_TOKEN;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "octopush-reviewer-token", "-w"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("reviewer token not found (Keychain service `octopush-reviewer-token`)");
  }
}

/**
 * Refuse to act unless `gh` is authenticated as the expected role — in
 * particular, never as the owner.
 */
export function assertActingAs(gh, expected, ids, env = process.env) {
  // A workflow's GITHUB_TOKEN and an App installation token can't call GET /user;
  // inside Actions they are those bots by construction (never a person).
  if (inActions(env) && isBotLogin(expected) && !sameLogin(expected, ids.owner)) return expected;
  const who = gh.viewer();
  if (sameLogin(who, ids.owner)) throw new Error(`refusing to run as the owner account (${who}); routines run as ${expected}`);
  if (!sameLogin(who, expected)) throw new Error(`gh is authenticated as ${who}, expected ${expected}`);
  return who;
}

/** `node scripts/routines/identity.mjs doctor` — check the setup without changing anything. */
async function doctor() {
  const { makeGh, ghRunAs } = await import("./gh.mjs");
  const ids = requireIdentities(loadIdentities());
  console.log(`owner ${ids.owner} · builder ${ids.builder} · reviewer ${ids.reviewer}`);
  console.log(`gh login: ${assertActingAs(makeGh(), ids.builder, ids)} ✓`);
  console.log(`reviewer token: ${assertActingAs(makeGh(ghRunAs(reviewerToken())), ids.reviewer, ids)} ✓`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] !== "doctor") { console.error("usage: identity.mjs doctor"); process.exit(64); }
  doctor().then((c) => process.exit(c), (e) => { reportFatal("identity", e); process.exit(2); });
}
