#!/usr/bin/env node
// What's new — record a short silent demo clip for every app changeset with
// `steps` (docs/WHATS-NEW.md §4–5, scripts/clips/README.md).
//
//   npm run clips:record -- <version|unreleased> [--slug <s>] [--force] [--verbose]
//                           [--from <dir>] [--keep-raw]
//
// Runs the REAL frontend (clips.html → src/clips/entry.tsx) on a Vite dev
// server, with Tauri IPC mocked from a scenario (scripts/clips/scenarios/),
// in headless Chromium via Playwright; performs the steps; writes
// `<slug>.webm` (≤ 1.5 MB) next to the changeset. Never commits anything.
// Exit code: 0 when every selected clip was written or already existed (no
// --force); 1 when any clip failed — including "no step target on screen" and
// "can't fit under the size cap" (the release routine treats 1 as "no clips").
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { installOverlay } from "./overlay.mjs";
import {
  ENCODE_LADDER,
  MAX_CLIP_BYTES,
  firstRung,
  fitDecision,
  parseArgs,
  parseChangeset,
  selectChangesets,
  stepDwellMs,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VIEWPORT = { width: 1280, height: 800 };
const require = createRequire(import.meta.url);
const log = (...a) => console.log("clips:", ...a);
const warn = (...a) => console.warn("clips: warning:", ...a);

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    console.error(
      "clips: Playwright is not installed. Install it (it is not a project dependency):\n" +
        "  npm i --no-save playwright && npx playwright install chromium",
    );
    process.exit(1);
  }
}

function hasBinary(bin) {
  return spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function startHarness(verbose) {
  const { createServer } = await import("vite");
  const port = await freePort();
  const server = await createServer({
    root: ROOT,
    clearScreen: false,
    logLevel: verbose ? "info" : "warn",
    server: { port, strictPort: true, host: "127.0.0.1", hmr: false },
  });
  await server.listen();
  return { server, url: `http://127.0.0.1:${port}/clips.html` };
}

function readEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "notes.md" && !f.startsWith("README"))
    .sort()
    .map((f) => {
      const slug = basename(f, ".md");
      let meta = null;
      try { meta = parseChangeset(readFileSync(join(dir, f), "utf8")).meta; } catch { /* reported by selection */ }
      return { slug, meta, hasClip: existsSync(join(dir, `${slug}.webm`)) };
    });
}

/** The scenarios' fixed "now" (scenarios/shared.ts), so relative times never drift between runs. */
const FIXED_NOW = "2026-10-28T15:00:00Z";

async function openHarness(page, url, scenario) {
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.goto(`${url}?octo-record=1&scenario=${encodeURIComponent(scenario)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__octoClips && (window.__octoClips.ready || window.__octoClips.error), null, { timeout: 90_000 });
  const err = await page.evaluate(() => window.__octoClips.error);
  if (err) throw new Error(`harness: ${err}`);
  // Let the initial IPC round-trips land and entrance motion finish.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1800);
}

/** Drive the steps ourselves (used when the app's tour runner isn't present). */
async function driveSteps(page, steps, verbose) {
  await page.evaluate(installOverlay);
  let shown = 0;
  for (const [i, st] of steps.entries()) {
    if (st.open) {
      const ok = await page.evaluate((n) => window.__octoClips.openSurface(n), st.open);
      if (!ok) warn(`step ${i + 1}: unknown surface "${st.open}"`);
      await page.waitForTimeout(500);
    }
    const loc = page.locator(`[data-tour="${st.target}"]`).first();
    try {
      // Clear the previous caption first, so a missing target isn't seconds of a stale frame.
      await loc.waitFor({ state: "visible", timeout: 300 }).catch(async () => {
        await page.evaluate(() => { window.__octoClipOverlay.caption(null); window.__octoClipOverlay.spotlight(null); });
        await loc.waitFor({ state: "visible", timeout: 2000 });
      });
    } catch {
      warn(`step ${i + 1}: [data-tour="${st.target}"] not on screen — skipped`);
      continue;
    }
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await loc.boundingBox();
    if (!box) { warn(`step ${i + 1}: target has no box — skipped`); continue; }
    shown++;
    const dwell = stepDwellMs(st.caption);
    await page.evaluate(([r, text]) => {
      window.__octoClipOverlay.spotlight(r);
      window.__octoClipOverlay.caption(text, r);
    }, [box, st.caption]);
    if (verbose) log(`  step ${i + 1}: ${st.action} ${st.target}`);
    if (st.action === "none") { await page.waitForTimeout(dwell); continue; }

    await page.waitForTimeout(Math.round(dwell * 0.55));
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.evaluate(([x, y]) => window.__octoClipOverlay.cursorTo(x, y), [cx, cy]);
    await page.waitForTimeout(380);
    if (st.action === "click") {
      await page.evaluate(() => window.__octoClipOverlay.press());
      await loc.click({ timeout: 3000 }).catch((e) => warn(`step ${i + 1}: click failed (${e.message.split("\n")[0]})`));
      await page.evaluate(() => window.__octoClipOverlay.spotlight(null));
    } else if (st.action === "hover") {
      await loc.hover({ timeout: 3000 }).catch((e) => warn(`step ${i + 1}: hover failed (${e.message.split("\n")[0]})`));
    } else if (st.action === "type") {
      await loc.click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.type(st.text ?? "", { delay: 55 });
    }
    await page.waitForTimeout(Math.round(dwell * 0.45));
  }
  await page.evaluate(() => window.__octoClipOverlay.clear());
  await page.waitForTimeout(700);
  return shown;
}

/** Record one changeset; returns { raw, leadSec, durationSec, log }. */
async function recordOne(browser, url, item, tmp, verbose) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    recordVideo: { dir: tmp, size: VIEWPORT },
  });
  const t0 = Date.now();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  if (verbose) page.on("console", (m) => { if (m.type() === "error") log(`  console: ${m.text().slice(0, 200)}`); });
  let tStart = 0;
  let shown = 0;
  let calls = null;
  let tEnd = 0;
  try {
    await openHarness(page, url, item.scenario);
    tStart = Date.now();
    const hasTour = await page.evaluate(() => typeof window.__octoTour?.play === "function");
    if (hasTour) {
      if (verbose) log("  using the app's tour runner (window.__octoTour.play)");
      // play() resolves with how many steps' targets were actually shown.
      const played = await page.evaluate((steps) => window.__octoTour.play(steps, { mode: "record" }), item.steps);
      await page.waitForTimeout(600);
      shown = typeof played === "number" ? played : item.steps.length;
    } else {
      shown = await driveSteps(page, item.steps, verbose);
    }
    calls = await page.evaluate(() => window.__octoClips.log);
  } finally {
    tEnd = Date.now();
    await context.close(); // flushes the video
  }
  const leadSec = Math.max(0, (tStart - t0) / 1000 - 0.15);
  const durationSec = tStart ? (tEnd - tStart) / 1000 : 0;
  const raw = await page.video().path();
  return { raw, leadSec, durationSec, shown, calls, pageErrors };
}

function encode(raw, out, leadSec, rung) {
  const args = [
    "-y", "-loglevel", "error", "-ss", leadSec.toFixed(2), "-i", raw, "-an",
    "-vf", `fps=${rung.fps},scale=1280:-2:flags=lanczos`,
    "-c:v", "libvpx-vp9", "-b:v", `${rung.kbps}k`, "-maxrate", `${Math.round(rung.kbps * 1.4)}k`, "-bufsize", `${rung.kbps * 2}k`,
    "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p", out,
  ];
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  return existsSync(out) ? statSync(out).size : 0;
}

/** Re-encode until it fits; returns the final size or null when it cannot fit. */
function fitClip(raw, dest, leadSec, durationSec, tmp, verbose) {
  const candidate = join(tmp, "fit.webm");
  for (let i = firstRung(durationSec); i < ENCODE_LADDER.length; i++) {
    const rung = ENCODE_LADDER[i];
    const size = encode(raw, candidate, leadSec, rung);
    if (verbose) log(`  encode ${rung.fps} fps · ${rung.kbps} kbps → ${(size / 1024).toFixed(0)} KB`);
    const d = fitDecision(size, i);
    if (d === "accept") { copyFileSync(candidate, dest); return size; }
    if (d === "give-up") return null;
  }
  return null;
}

function printCoverage(calls) {
  if (!calls) return;
  const names = Object.keys(calls.calls).sort();
  log(`  ${names.length} command(s) invoked; ${calls.defaulted.length} answered by a default (no fixture):`);
  if (calls.defaulted.length) log(`    ${[...calls.defaulted].sort().join(", ")}`);
  if (calls.failed.length) log(`  handlers that threw: ${calls.failed.join(", ")}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const fromIdx = argv.indexOf("--from");
  let fromDir = null;
  if (fromIdx >= 0) { fromDir = resolve(argv[fromIdx + 1] ?? ""); argv.splice(fromIdx, 2); }
  const opts = parseArgs(argv);
  const dir = fromDir ?? join(ROOT, "whats-new", opts.dir);
  const { record, skipped } = selectChangesets(readEntries(dir), opts);
  for (const s of skipped) if (opts.verbose || opts.slug) log(`skip ${s.slug}: ${s.reason}`);
  if (!record.length) { log(`nothing to record in ${relative(ROOT, dir) || dir}`); return 0; }

  const { chromium } = loadPlaywright();
  const ffmpeg = hasBinary("ffmpeg");
  if (!ffmpeg) warn("ffmpeg not found — clips are kept as Playwright recorded them (no trim, no size fitting)");

  const tmp = mkdtempSync(join(tmpdir(), "octo-clips-"));
  const { server, url } = await startHarness(opts.verbose);
  let browser;
  let failures = 0;
  try {
    try {
      browser = await chromium.launch();
    } catch (e) {
      console.error(`clips: could not launch Chromium (${e.message.split("\n")[0]}).\n  Try: npx playwright install chromium`);
      return 1;
    }
    // Warm-up load so Vite's first compile isn't in any recording.
    {
      const page = await browser.newPage({ viewport: VIEWPORT });
      log("warming up the harness…");
      await openHarness(page, url, "default");
      await page.close();
    }
    for (const item of record) {
      const dest = join(dir, `${item.slug}.webm`);
      log(`recording ${item.slug} (scenario: ${item.scenario}, ${item.steps.length} step(s))`);
      try {
        const r = await recordOne(browser, url, item, tmp, opts.verbose);
        if (r.pageErrors.length) warn(`page errors:\n    ${r.pageErrors.slice(0, 8).join("\n    ")}`);
        if (opts.verbose) printCoverage(r.calls);
        if (r.shown === 0) { warn(`${item.slug}: no step target was on screen — no clip`); failures++; continue; }
        if (opts.keepRaw) copyFileSync(r.raw, join(dir, `${item.slug}.raw.webm`));
        let size;
        if (ffmpeg) {
          size = fitClip(r.raw, dest, r.leadSec, r.durationSec, tmp, opts.verbose);
        } else {
          const rawSize = statSync(r.raw).size;
          size = fitDecision(rawSize, ENCODE_LADDER.length - 1) === "accept" ? (copyFileSync(r.raw, dest), rawSize) : null;
        }
        if (size == null) { warn(`${item.slug}: could not fit under ${MAX_CLIP_BYTES / 1024 / 1024} MB — skipped`); failures++; continue; }
        log(`  ✓ ${relative(ROOT, dest)} · ${(size / 1024).toFixed(0)} KB · ${r.durationSec.toFixed(1)} s`);
      } catch (e) {
        warn(`${item.slug}: ${e.message.split("\n")[0]}`);
        failures++;
      }
    }
  } finally {
    await browser?.close();
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error("clips:", e.message ?? e); process.exit(1); });
