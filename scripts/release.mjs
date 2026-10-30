#!/usr/bin/env node
/**
 * Octopush release script.
 *
 * Usage:
 *   npm run release -- 0.1.1 [--channel beta|stable]
 *
 * Channels (docs/RELEASING.md): every release is published to the BETA channel
 * by default — a GitHub prerelease (never GitHub "latest") whose latest.json is
 * also uploaded to the moving `beta-channel` release. The owner promotes a beta
 * to stable with .github/workflows/promote.yml. `--channel stable` publishes a
 * full release directly (and refreshes `beta-channel` too, so beta users never
 * see an older version than stable).
 *
 * Notes: when whats-new/<version>/notes.md exists (written by
 * `node scripts/whats-new.mjs collect`), it tops the GitHub release body and,
 * trimmed to 4000 chars, becomes latest.json `notes`.
 *
 * What it does, in order:
 *   1. Validates the working tree is clean and on `main`.
 *   2. Bumps version in package.json, src-tauri/Cargo.toml,
 *      src-tauri/tauri.conf.json.
 *   3. Builds the macOS bundle (DMG + .app + .app.tar.gz + .sig) using
 *      the Ed25519 private key at ~/.octopush-keys/updater_key.
 *   4. Generates latest.json describing the release in the format the
 *      Tauri updater expects.
 *   5. Commits the version bump, tags v<version>, pushes both.
 *   6. Creates a GitHub release via `gh` (a prerelease on the beta channel)
 *      and uploads the DMG + .app.tar.gz + .sig + latest.json as assets.
 *   7. Refreshes latest.json on the `beta-channel` release.
 *
 * Pre-reqs (must already be set up; this script doesn't bootstrap them):
 *   - `gh` CLI authed (token with `repo` scope).
 *   - Ed25519 keypair at ~/.octopush-keys/updater_key{,.pub}; the
 *     matching public key must be the `pubkey` field in
 *     src-tauri/tauri.conf.json.
 *
 * Apple Developer-ID signing + notarization (OPTIONAL — see docs/gtm-legitimacy.md):
 *   When the following env vars are present, `tauri build` automatically
 *   Developer-ID-signs, notarizes, and staples the bundle (Tauri 2 reads them
 *   natively), and the release notes drop the `xattr` unblock step. When they
 *   are absent, the build is unsigned exactly as before — nothing breaks.
 *     - APPLE_SIGNING_IDENTITY  (e.g. "Developer ID Application: You (TEAMID)")
 *         …or APPLE_CERTIFICATE (+ APPLE_CERTIFICATE_PASSWORD) to import a
 *         base64 .p12 into a temp keychain.
 *     - Notarization creds, either:
 *         APPLE_ID + APPLE_PASSWORD (app-specific) + APPLE_TEAM_ID, or
 *         APPLE_API_ISSUER + APPLE_API_KEY + APPLE_API_KEY_PATH (App Store Connect key).
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BETA_TAG,
  BETA_TITLE,
  buildManifest,
  bumpVersionFiles,
  channelCreateArgs,
  ciPublishDecision,
  pendingChangesets,
  parseChannel,
  releaseBody,
  shouldRefreshBetaManifest,
} from "./release-lib.mjs";

// ── Paths ──────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(__dirname, "..");
const TAURI_CONF = join(REPO, "src-tauri/tauri.conf.json");
// Universal build emits to a per-target dir. Releases always ship
// universal so the same DMG runs on Intel + Apple Silicon.
const BUNDLE_DIR = join(
  REPO,
  "src-tauri/target/universal-apple-darwin/release/bundle",
);
const KEY_PATH = join(process.env.HOME || "", ".octopush-keys/updater_key");

// CI mode: driven by GitHub Actions (or `--ci`). In CI the tag already exists,
// signing keys arrive via env/secrets, and the runner is ephemeral — so we skip
// the local-only ceremony (branch/dirty checks, version bump, commit/tag/push)
// and go straight to build → verify → publish. One source of build+publish
// logic serves both the local one-command flow and CI. See docs/RELEASING.md.
const CI = process.env.CI === "true" || process.argv.includes("--ci");

// Release channel: beta (default) or stable. See the header and docs/RELEASING.md.
let CHANNEL;
try {
  CHANNEL = parseChannel(process.argv.slice(2));
} catch (e) {
  console.error(`\x1b[31m✗\x1b[0m ${e.message}`);
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────

function die(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

function step(msg) {
  console.log(`\x1b[33m▸\x1b[0m ${msg}`);
}

function ok(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO, stdio: "inherit", ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: REPO }).toString().trim();
}

// ── Pre-flight ─────────────────────────────────────────────────────

// Version: an explicit arg wins; in CI we otherwise take it from the committed
// tauri.conf.json (the tag was cut against that version).
let newVersion = process.argv.find((a) => /^\d+\.\d+\.\d+(-\w+)?$/.test(a));
if (!newVersion && CI) {
  newVersion = JSON.parse(readFileSync(TAURI_CONF, "utf8")).version;
}
if (!newVersion || !/^\d+\.\d+\.\d+(-\w+)?$/.test(newVersion)) {
  die(
    `Usage: npm run release -- <version>  (e.g. 0.1.1)\nGot: "${
      newVersion ?? ""
    }"`,
  );
}

// In CI the private key comes straight from the TAURI_SIGNING_PRIVATE_KEY
// secret (env), so the on-disk key file is optional there. Locally we require
// the key file. The updater key is ALWAYS required — an unsigned updater
// artifact would break in-app updates; only Apple signing degrades gracefully.
const HAVE_ENV_KEY = !!process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!HAVE_ENV_KEY && !existsSync(KEY_PATH)) {
  die(
    `Updater signing key not found.\n` +
      `  - Local: generate one at ${KEY_PATH} with\n` +
      `      npx @tauri-apps/cli signer generate --write-keys ${KEY_PATH} --password ""\n` +
      `  - CI: set the TAURI_SIGNING_PRIVATE_KEY secret.\n` +
      `The matching public key must be tauri.conf.json → plugins.updater.pubkey.`,
  );
}

if (!CI) {
  const branch = runCapture("git rev-parse --abbrev-ref HEAD");
  if (branch !== "main") {
    die(`Releases must be cut from main. You're on \`${branch}\`.`);
  }

  const status = runCapture("git status --porcelain");
  if (status) {
    die(`Working tree is dirty:\n${status}\n\nCommit or stash first.`);
  }
} else {
  // Sanity-check the tag matches the version we're about to publish.
  // On a tag push a mismatch would republish (and clobber) another version.
  const ref = process.env.GITHUB_REF_NAME;
  if (process.env.GITHUB_REF_TYPE === "tag" && ref && ref !== `v${newVersion}`) {
    die(`Tag ${ref} does not match tauri.conf.json version v${newVersion} — refusing to publish.`);
  }
  // Changesets still in unreleased/ with no whats-new/<version>/ means the
  // notes were never collected: the release would ship without its tips, and
  // the in-app What's new would skip them for good.
  const pending = pendingChangesets(join(REPO, "whats-new"));
  if (pending.length && !existsSync(join(REPO, "whats-new", newVersion))) {
    die(
      `whats-new/unreleased/ has ${pending.length} changeset(s) but whats-new/${newVersion}/ doesn't exist — ` +
        `run \`node scripts/whats-new.mjs collect ${newVersion}\` and commit it before tagging.`,
    );
  }
}

step(`Releasing Octopush v${newVersion} on the ${CHANNEL} channel${CI ? " (CI mode)" : ""}`);

// ── Apple signing posture ─────────────────────────────────────────
// Signing + notarization are fully env-driven: the build spawn below already
// spreads `process.env`, so Tauri 2 picks these up with no extra plumbing. We
// only DETECT them here, to (a) tell the operator what kind of build this is and
// (b) drop the `xattr` unblock from the release notes when the DMG is notarized.
const APPLE_SIGN = !!(process.env.APPLE_SIGNING_IDENTITY || process.env.APPLE_CERTIFICATE);
const APPLE_NOTARIZE = !!(
  (process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID) ||
  (process.env.APPLE_API_ISSUER && process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_PATH)
);
const NOTARIZED = APPLE_SIGN && APPLE_NOTARIZE;

if (NOTARIZED) {
  ok("Apple Developer-ID signing + notarization: ON (env present) — Gatekeeper-clean build");
} else if (APPLE_SIGN) {
  // Signing without notarization credentials still leaves Gatekeeper warnings,
  // so we don't advertise a clean install — but we surface the half-config.
  console.log(
    "\x1b[33m▸\x1b[0m Apple signing identity present but notarization creds are NOT — " +
      "the DMG will be signed yet still quarantined. Set APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID " +
      "(or APPLE_API_*) to notarize. See docs/gtm-legitimacy.md.",
  );
} else {
  console.log(
    "\x1b[33m▸\x1b[0m Unsigned build (no APPLE_SIGNING_IDENTITY). Users will need the `xattr` " +
      "unblock. To ship a Gatekeeper-clean release, see docs/gtm-legitimacy.md.",
  );
}

// ── 1. Bump versions ──────────────────────────────────────────────

if (CI) {
  ok(`Version ${newVersion} taken from the tagged commit (no bump in CI)`);
} else {
  step("Bumping version in package.json, Cargo.toml, Cargo.lock, tauri.conf.json");

  // Only the version line of each file changes (same helper the nightly beta
  // routine uses, so manual and automatic release commits look identical).
  try {
    bumpVersionFiles(REPO, newVersion);
  } catch (e) {
    die(`Failed to bump versions: ${e.message}`);
  }

  ok(`Bumped to ${newVersion}`);
}

// ── 2. Build ─────────────────────────────────────────────────────

step(
  `Building release bundle (updater-signed${
    NOTARIZED ? " + Apple-notarized" : APPLE_SIGN ? " + Apple-signed" : ""
  }) — this takes a few minutes`,
);

// Tauri 2 reads the private key content from TAURI_SIGNING_PRIVATE_KEY.
// (The `_PATH` variant in some docs isn't honored by the bundler.)
// In CI the key is already in the env (secret); locally we read the key file.
const privateKey = HAVE_ENV_KEY
  ? process.env.TAURI_SIGNING_PRIVATE_KEY
  : readFileSync(KEY_PATH, "utf8");

run("npm run tauri:build:universal", {
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    // Empty password unless one was provided (keep aligned with how the key
    // was generated; CI can override via TAURI_SIGNING_PRIVATE_KEY_PASSWORD).
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  },
});

// ── 3. Locate artifacts ──────────────────────────────────────────

step("Locating bundle artifacts");

const dmgDir = join(BUNDLE_DIR, "dmg");
const macosDir = join(BUNDLE_DIR, "macos");

const dmgFile = readdirSync(dmgDir).find(
  (f) => f.endsWith(".dmg") && f.includes(newVersion),
);
if (!dmgFile) die(`No .dmg matching version ${newVersion} in ${dmgDir}`);

const tarball = readdirSync(macosDir).find((f) => f.endsWith(".app.tar.gz"));
const sigFile = readdirSync(macosDir).find(
  (f) => f.endsWith(".app.tar.gz.sig"),
);
if (!tarball || !sigFile) {
  die(
    `Missing .app.tar.gz / .sig in ${macosDir} — is createUpdaterArtifacts enabled?`,
  );
}

const dmgPath = join(dmgDir, dmgFile);
const tarPath = join(macosDir, tarball);
const sigPath = join(macosDir, sigFile);
const signature = readFileSync(sigPath, "utf8").trim();

// Stable permalink asset. octopush.sh/download →
// releases/latest/download/Octopush.dmg, so every release MUST publish an asset
// named exactly `Octopush.dmg` (a byte-copy of the versioned universal DMG — the
// code signature lives inside the file, so a copy stays valid/notarized). We keep
// the versioned name too, for archives.
const stableDmgPath = join(dmgDir, "Octopush.dmg");
copyFileSync(dmgPath, stableDmgPath);

ok(`DMG (versioned): ${dmgFile}`);
ok(`DMG (stable permalink): Octopush.dmg`);
ok(`Tarball: ${tarball}`);
ok(`Signature: ${sigFile}`);

// ── 3b. Verify sidecars made it into the bundle ──────────────────
// A missing/empty externalBin sidecar means a feature ships dead (e.g.
// octopush-mcp absent → "Connect to Claude Code" registers a nonexistent
// binary). Tauri only errors when a sidecar is missing at copy time; a
// stale build tree can still produce a bundle that silently lacks one.
// Fail the release here, before anything is tagged or published.
step("Verifying bundled sidecars");

const appDir = readdirSync(macosDir).find((f) => f.endsWith(".app"));
if (!appDir) die(`No .app found in ${macosDir}`);
const bundleConf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
const sidecars = bundleConf?.bundle?.externalBin ?? [];
const macosBinDir = join(macosDir, appDir, "Contents/MacOS");
for (const entry of sidecars) {
  const name = entry.split("/").pop();
  const binPath = join(macosBinDir, name);
  if (!existsSync(binPath) || statSync(binPath).size === 0) {
    die(
      `Sidecar '${name}' is missing or empty in ${appDir}.\n` +
        `  Expected a non-empty binary at ${binPath}.\n` +
        `  This usually means the build tree is stale — rebuild from a clean ` +
        `checkout of the merged branch (the externalBin list and the compiled ` +
        `binaries must agree).`,
    );
  }
  ok(`Sidecar bundled: ${name} (${statSync(binPath).size} bytes)`);
}

// ── 3c. Verify Apple signing / notarization actually took ────────
// A post-build sanity print, not a gate: `tauri build` already hard-fails if a
// requested identity can't sign or notarization is rejected, so reaching here
// implies success. We confirm the artifacts so a surprise is visible in the log.
// Warn-only: never fail a good bundle on a flaky verify.
// NB: Tauri staples the notarization ticket to the `.app` (the DMG is signed but
// not stapled), so both checks target the `.app`.
if (APPLE_SIGN) {
  step("Verifying Apple signature");
  const appPath = join(macosDir, appDir);
  try {
    execSync(`codesign --verify --strict --verbose=2 "${appPath}"`, { stdio: "ignore" });
    ok("Developer-ID signature valid (codesign --verify)");
  } catch {
    console.log(
      "\x1b[33m▸\x1b[0m codesign --verify did not pass on the .app — the signing identity " +
        "may not have applied. Inspect with: codesign -dv --verbose=4 <app>.",
    );
  }
  if (NOTARIZED) {
    try {
      execSync(`xcrun stapler validate "${appPath}"`, { stdio: "ignore" });
      ok("Notarization ticket stapled to Octopush.app (stapler validate)");
    } catch {
      console.log(
        "\x1b[33m▸\x1b[0m stapler validate did not pass on the .app — notarization may not have " +
          "completed. Don't advertise a clean install until `xcrun stapler validate` on the .app passes.",
      );
    }
    // The Gatekeeper assessment a real user's Mac performs on first launch.
    try {
      const assess = execSync(`spctl -a -vv "${appPath}" 2>&1`).toString();
      if (/accepted/.test(assess)) {
        ok("Gatekeeper assessment: accepted (spctl -a -vv)");
      } else {
        console.log(`\x1b[33m▸\x1b[0m spctl -a -vv did not report 'accepted':\n${assess}`);
      }
    } catch (e) {
      console.log(
        "\x1b[33m▸\x1b[0m spctl -a -vv rejected the .app — it will show a Gatekeeper warning. " +
          `Output:\n${e.stdout?.toString?.() ?? e.message}`,
      );
    }
  }
}

// ── 4. Build latest.json ─────────────────────────────────────────

step("Writing latest.json");

// Universal bundles work on both architectures, so latest.json points
// both `darwin-aarch64` and `darwin-x86_64` to the same tarball URL.
// The Tauri updater on each client picks whichever key matches its
// host arch — both resolve to the same lipo-merged .app.tar.gz.
const releaseUrl = `https://github.com/octopush-sh/octopush/releases/download/v${newVersion}/${encodeURIComponent(
  tarball,
)}`;

// Release notes from the changesets (docs/WHATS-NEW.md §5), when collected.
const NOTES_MD = join(REPO, "whats-new", newVersion, "notes.md");
const changesetNotes = existsSync(NOTES_MD) ? readFileSync(NOTES_MD, "utf8") : "";
if (changesetNotes) ok(`Release notes: whats-new/${newVersion}/notes.md`);
else console.log(`\x1b[33m▸\x1b[0m No whats-new/${newVersion}/notes.md — using the generic notes`);

const latestJson = buildManifest({
  version: newVersion,
  notes: changesetNotes,
  signature,
  url: releaseUrl,
  pubDate: new Date().toISOString(),
});
const latestPath = join(BUNDLE_DIR, "latest.json");
writeFileSync(latestPath, JSON.stringify(latestJson, null, 2));
ok(`latest.json written (darwin-aarch64 + darwin-x86_64 → universal)`);

// ── 5. Commit, tag, push ─────────────────────────────────────────

if (CI) {
  ok("Skipping commit/tag/push (CI publishes from an existing tag)");
} else {
  step("Commiting version bump + tagging");

  run(`git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json`);
  run(`git commit -m "chore: release v${newVersion}"`);
  run(`git tag v${newVersion}`);
  run(`git push origin main`);
  run(`git push origin v${newVersion}`);
}

// ── 6. GitHub release ────────────────────────────────────────────

step("Creating GitHub release + uploading assets");

// Release notes. A notarized build installs clean — no Gatekeeper unblock — so
// we drop the `xattr` step entirely (shipping it on a notarized build would be
// wrong and read as amateurish). An unsigned build keeps the unblock. Either
// way, users already on a prior version update in-app and never see this.
const notesBody = releaseBody({ version: newVersion, notes: changesetNotes, notarized: NOTARIZED });

// Write notes to a temp file so multi-line markdown survives the shell.
const notesFile = join(BUNDLE_DIR, ".release-notes.md");
writeFileSync(notesFile, notesBody);

// Assets: the stable `Octopush.dmg` (permalink target for octopush.sh/download),
// the versioned DMG (archives), the updater tarball + its .sig, and latest.json.
const assets = [stableDmgPath, dmgPath, tarPath, sigPath, latestPath];
const ghCmd = [
  `gh release create v${newVersion}`,
  `--title "v${newVersion}"`,
  `--notes-file "${notesFile}"`,
  ...channelCreateArgs(CHANNEL),
  ...assets.map((p) => `"${p}"`),
].join(" ");
// In CI a release for the tag may already exist (a re-run). Re-upload only
// into an existing *beta* (draft or prerelease) — never over a promoted stable
// release — and make sure it ends up published as a prerelease.
let existing = null;
if (CI) {
  try {
    existing = JSON.parse(
      execSync(`gh api repos/{owner}/{repo}/releases/tags/v${newVersion}`, {
        cwd: REPO,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString(),
    );
  } catch {
    existing = null; // 404: create it below
  }
}
const decision = ciPublishDecision(CI, existing, CHANNEL);
if (decision === "refuse") {
  die(`v${newVersion} is already a published stable release — refusing to overwrite its assets.`);
} else if (decision === "reupload") {
  console.log(`\x1b[33m▸\x1b[0m v${newVersion} already exists as a beta — re-uploading its assets`);
  run([`gh release upload v${newVersion}`, ...assets.map((p) => `"${p}"`), "--clobber"].join(" "));
  run(`gh release edit v${newVersion} --draft=false --prerelease --latest=false`);
} else {
  run(ghCmd);
}

// ── 7. Beta channel manifest ─────────────────────────────────────
// `beta-channel` is a moving prerelease whose only asset is the newest
// latest.json (beta builds and stable ones alike). It never moves backwards.

step(`Refreshing the ${BETA_TAG} manifest`);

let betaExists = true;
try {
  execSync(`gh release view ${BETA_TAG} --json tagName`, { cwd: REPO, stdio: "ignore" });
} catch {
  betaExists = false;
}
if (!betaExists) {
  const betaNotes = join(BUNDLE_DIR, ".beta-channel-notes.md");
  writeFileSync(
    betaNotes,
    "Moving manifest for the Octopush beta update channel. Its `latest.json` always " +
      "describes the newest release. Not an installable release — see the versioned releases.\n",
  );
  run(
    `gh release create ${BETA_TAG} --prerelease --latest=false --title "${BETA_TITLE}" --notes-file "${betaNotes}"`,
  );
}
let currentBeta = null;
if (betaExists) {
  try {
    const cur = execSync(`gh release download ${BETA_TAG} --pattern latest.json --output -`, {
      cwd: REPO,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    currentBeta = JSON.parse(cur).version ?? null;
  } catch {
    currentBeta = null; // no manifest yet (or unreadable) — replace it
  }
}
if (shouldRefreshBetaManifest(currentBeta, newVersion)) {
  run(`gh release upload ${BETA_TAG} "${latestPath}" --clobber`);
  ok(`${BETA_TAG}/latest.json → v${newVersion}`);
} else {
  console.log(
    `\x1b[33m▸\x1b[0m ${BETA_TAG} already advertises v${currentBeta} (newer than v${newVersion}) — left as is`,
  );
}

console.log("");
ok(
  CHANNEL === "beta"
    ? `Released v${newVersion} on the beta channel (prerelease). Promote it to stable ` +
        `with the promote workflow: gh workflow run promote.yml -f version=${newVersion}`
    : `Released v${newVersion} — clients with auto-update will see it within 6h ` +
        `or on next launch.`,
);
console.log("");
console.log(
  `   ↗ https://github.com/octopush-sh/octopush/releases/tag/v${newVersion}`,
);
