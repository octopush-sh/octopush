#!/usr/bin/env node
/**
 * Octopush release script.
 *
 * Usage:
 *   npm run release -- 0.1.1
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
 *   6. Creates a GitHub release via `gh` and uploads the DMG +
 *      .app.tar.gz + .sig + latest.json as assets.
 *
 * Pre-reqs (must already be set up; this script doesn't bootstrap them):
 *   - `gh` CLI authed (token with `repo` scope).
 *   - Ed25519 keypair at ~/.octopush-keys/updater_key{,.pub}; the
 *     matching public key must be the `pubkey` field in
 *     src-tauri/tauri.conf.json.
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ──────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(__dirname, "..");
const PKG = join(REPO, "package.json");
const CARGO = join(REPO, "src-tauri/Cargo.toml");
const TAURI_CONF = join(REPO, "src-tauri/tauri.conf.json");
// Universal build emits to a per-target dir. Releases always ship
// universal so the same DMG runs on Intel + Apple Silicon.
const BUNDLE_DIR = join(
  REPO,
  "src-tauri/target/universal-apple-darwin/release/bundle",
);
const KEY_PATH = join(process.env.HOME, ".octopush-keys/updater_key");

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

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(-\w+)?$/.test(newVersion)) {
  die(
    `Usage: npm run release -- <version>  (e.g. 0.1.1)\nGot: "${
      newVersion ?? ""
    }"`,
  );
}

if (!existsSync(KEY_PATH)) {
  die(
    `Signing key not found at ${KEY_PATH}\n` +
      `Generate one with: npx @tauri-apps/cli signer generate --write-keys ${KEY_PATH} --password ""`,
  );
}

const branch = runCapture("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  die(`Releases must be cut from main. You're on \`${branch}\`.`);
}

const status = runCapture("git status --porcelain");
if (status) {
  die(`Working tree is dirty:\n${status}\n\nCommit or stash first.`);
}

step(`Releasing Octopush v${newVersion}`);

// ── 1. Bump versions ──────────────────────────────────────────────

step("Bumping version in package.json, Cargo.toml, tauri.conf.json");

// package.json
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
pkg.version = newVersion;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

// Cargo.toml — only the [package] version, not deps
const cargo = readFileSync(CARGO, "utf8");
const cargoBumped = cargo.replace(
  /^(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/m,
  `$1"${newVersion}"`,
);
if (cargoBumped === cargo) die("Failed to bump Cargo.toml version");
writeFileSync(CARGO, cargoBumped);

// tauri.conf.json
const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
conf.version = newVersion;
writeFileSync(TAURI_CONF, JSON.stringify(conf, null, 2) + "\n");

ok(`Bumped to ${newVersion}`);

// ── 2. Build ─────────────────────────────────────────────────────

step("Building release bundle (signed) — this takes a few minutes");

// Tauri 2 reads the private key content from TAURI_SIGNING_PRIVATE_KEY.
// (The `_PATH` variant in some docs isn't honored by the bundler.)
const privateKey = readFileSync(KEY_PATH, "utf8");

run("npm run tauri:build:universal", {
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: privateKey,
    // Empty password — keep aligned with how the key was generated.
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
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

ok(`DMG: ${dmgFile}`);
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
const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
const sidecars = conf?.bundle?.externalBin ?? [];
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

// ── 4. Build latest.json ─────────────────────────────────────────

step("Writing latest.json");

// Universal bundles work on both architectures, so latest.json points
// both `darwin-aarch64` and `darwin-x86_64` to the same tarball URL.
// The Tauri updater on each client picks whichever key matches its
// host arch — both resolve to the same lipo-merged .app.tar.gz.
const releaseUrl = `https://github.com/johnatan-velez/octopush/releases/download/v${newVersion}/${encodeURIComponent(
  tarball,
)}`;

const updaterEntry = { signature, url: releaseUrl };
const latestJson = {
  version: newVersion,
  notes: `Octopush ${newVersion}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": updaterEntry,
    "darwin-x86_64": updaterEntry,
  },
};
const latestPath = join(BUNDLE_DIR, "latest.json");
writeFileSync(latestPath, JSON.stringify(latestJson, null, 2));
ok(`latest.json written (darwin-aarch64 + darwin-x86_64 → universal)`);

// ── 5. Commit, tag, push ─────────────────────────────────────────

step("Commiting version bump + tagging");

run(`git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json`);
run(`git commit -m "chore: release v${newVersion}"`);
run(`git tag v${newVersion}`);
run(`git push origin main`);
run(`git push origin v${newVersion}`);

// ── 6. GitHub release ────────────────────────────────────────────

step("Creating GitHub release + uploading assets");

// Release notes: short description plus the Gatekeeper unblock command
// since Octopush isn't notarized (no Apple Developer Account).
// Users who already have v0.1.1+ installed get updates in-app via the
// Tauri updater — they never see this notice.
const notesBody = `Octopush ${newVersion}

Universal binary — runs natively on both **Apple Silicon** and **Intel** Macs.

## Install (first time only)

1. Download the \`.dmg\` below.
2. Open it and drag **Octopush.app** to **Applications**.
3. Open Terminal and run:

   \`\`\`
   xattr -cr /Applications/Octopush.app
   \`\`\`

4. Launch Octopush from Applications.

The \`xattr\` step removes macOS Gatekeeper's quarantine flag. It's only
needed for the first manual install — after that, future versions
arrive in-app via the auto-updater.
`;

// Write notes to a temp file so multi-line markdown survives the shell.
const notesFile = join(BUNDLE_DIR, ".release-notes.md");
writeFileSync(notesFile, notesBody);

const ghCmd = [
  `gh release create v${newVersion}`,
  `--title "v${newVersion}"`,
  `--notes-file "${notesFile}"`,
  `"${dmgPath}"`,
  `"${tarPath}"`,
  `"${sigPath}"`,
  `"${latestPath}"`,
].join(" ");
run(ghCmd);

console.log("");
ok(
  `Released v${newVersion} — clients with auto-update will see it within 6h ` +
    `or on next launch.`,
);
console.log("");
console.log(
  `   ↗ https://github.com/johnatan-velez/octopush/releases/tag/v${newVersion}`,
);
