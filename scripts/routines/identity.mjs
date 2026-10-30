// Who is who in the nightly cycle (VISION.md §8, docs/ROUTINES.md "Setup").
//
// Three GitHub accounts, never the same:
//   owner     — the human. Only their comments count as answers; never used by routines.
//   builder   — opens agent PRs, labels, posts digests, applies the owner's answers.
//               The default `gh` login of the macOS user the routines run as.
//   reviewer  — reviews agent PRs and is the only identity whose approval counts.
//               Its token lives in that user's Keychain (service `octopush-reviewer-token`).
//
// Configuration: environment variables, or ~/.config/octopush-routines/identity.env:
//   OCTOPUSH_OWNER_LOGIN=…   OCTOPUSH_BUILDER_LOGIN=…   OCTOPUSH_REVIEWER_LOGIN=…
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const FILE = join(homedir(), ".config", "octopush-routines", "identity.env");

export function loadIdentities(env = process.env, file = FILE) {
  const fromFile = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(OCTOPUSH_(?:OWNER|BUILDER|REVIEWER)_LOGIN)\s*=\s*"?([A-Za-z0-9-]+)"?\s*$/.exec(line);
      if (m) fromFile[m[1]] = m[2];
    }
  }
  const get = (k) => env[k] || fromFile[k] || "";
  return {
    owner: get("OCTOPUSH_OWNER_LOGIN"),
    builder: get("OCTOPUSH_BUILDER_LOGIN"),
    reviewer: get("OCTOPUSH_REVIEWER_LOGIN"),
  };
}

/** Throws unless all three logins are set and pairwise different (case-insensitive). */
export function requireIdentities(ids) {
  const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`identities not configured: ${missing.join(", ")} (see docs/ROUTINES.md "Setup")`);
  const l = [ids.owner, ids.builder, ids.reviewer].map((s) => s.toLowerCase());
  if (new Set(l).size !== 3) throw new Error("owner, builder and reviewer must be three different GitHub accounts");
  return ids;
}

export const sameLogin = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The reviewer's token: env OCTOPUSH_REVIEWER_TOKEN, else the macOS Keychain. */
export function reviewerToken(env = process.env) {
  if (env.OCTOPUSH_REVIEWER_TOKEN) return env.OCTOPUSH_REVIEWER_TOKEN;
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
export function assertActingAs(gh, expected, ids) {
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
  doctor().then((c) => process.exit(c), (e) => { console.error(`identity: ${e.message}`); process.exit(2); });
}
