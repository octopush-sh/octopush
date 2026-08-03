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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync } from "node:fs";
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
const KEY_PATH = join(process.env.HOME || "", ".octopush-keys/updater_key");

// CI mode: driven by GitHub Actions (or `--ci`). In CI the tag already exists,
// signing keys arrive via env/secrets, and the runner is ephemeral — so we skip
// the local-only ceremony (branch/dirty checks, version bump, commit/tag/push)
// and go straight to build → verify → publish. One source of build+publish
// logic serves both the local one-command flow and CI. See docs/RELEASING.md.
const CI = process.env.CI === "true" || process.argv.includes("--ci");

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
  const ref = process.env.GITHUB_REF_NAME;
  if (ref && ref !== `v${newVersion}`) {
    console.log(
      `\x1b[33m▸\x1b[0m Tag ${ref} does not match tauri.conf.json version ` +
        `v${newVersion}. Publishing v${newVersion}.`,
    );
  }
}

step(`Releasing Octopush v${newVersion}${CI ? " (CI mode)" : ""}`);

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

// Assets: the stable `Octopush.dmg` (permalink target for octopush.sh/download),
// the versioned DMG (archives), the updater tarball + its .sig, and latest.json.
const assets = [stableDmgPath, dmgPath, tarPath, sigPath, latestPath];
const ghCmd = [
  `gh release create v${newVersion}`,
  `--title "v${newVersion}"`,
  `--notes-file "${notesFile}"`,
  ...assets.map((p) => `"${p}"`),
].join(" ");
// In CI a release for the tag may already exist (e.g. a re-run) — fall back to
// uploading assets with --clobber so a retry is idempotent.
try {
  run(ghCmd);
} catch (e) {
  if (CI) {
    console.log("\x1b[33m▸\x1b[0m release create failed (may already exist) — uploading assets with --clobber");
    run(
      [`gh release upload v${newVersion}`, ...assets.map((p) => `"${p}"`), "--clobber"].join(" "),
    );
  } else {
    throw e;
  }
}

console.log("");
ok(
  `Released v${newVersion} — clients with auto-update will see it within 6h ` +
    `or on next launch.`,
);
console.log("");
console.log(
  `   ↗ https://github.com/octopush-sh/octopush/releases/tag/v${newVersion}`,
);
