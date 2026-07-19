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
    "\x1b[33m▸\x1b[0m Unsigned build (no APPLE_* env). Users will need the `xattr` unblock. " +
      "To ship a Gatekeeper-clean release, see docs/gtm-legitimacy.md.",
  );
}

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

step(
  `Building release bundle (updater-signed${
    NOTARIZED ? " + Apple-notarized" : APPLE_SIGN ? " + Apple-signed" : ""
  }) — this takes a few minutes`,
);

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
// Belt-and-suspenders: `tauri build` fails hard if a requested signing identity
// can't sign, so reaching here already implies success — but we confirm the
// stapled ticket so a mis-set notarization cred can't silently ship a build we
// then advertise as Gatekeeper-clean. Warn-only: never fail a good bundle on a
// flaky verify.
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
      execSync(`xcrun stapler validate "${dmgPath}"`, { stdio: "ignore" });
      ok("Notarization ticket stapled to the DMG (stapler validate)");
    } catch {
      console.log(
        "\x1b[33m▸\x1b[0m stapler validate did not pass on the DMG — notarization may not have " +
          "completed. The DMG can still notarize later; do not advertise a clean install until it does.",
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

// Release notes. A notarized build installs clean — no Gatekeeper unblock — so
// we drop the `xattr` step entirely (shipping it on a notarized build would be
// wrong and read as amateurish). An unsigned build keeps the unblock. Either
// way, users already on a prior version update in-app and never see this.
const notesBody = NOTARIZED
  ? `Octopush ${newVersion}

Universal binary — runs natively on both **Apple Silicon** and **Intel** Macs.
Signed with a Developer ID certificate and notarized by Apple.

## Install

1. Download the \`.dmg\` below.
2. Open it and drag **Octopush.app** to **Applications**.
3. Launch Octopush from Applications.

Future versions arrive in-app via the auto-updater.
`
  : `Octopush ${newVersion}

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
  `   ↗ https://github.com/octopush-sh/octopush/releases/tag/v${newVersion}`,
);
