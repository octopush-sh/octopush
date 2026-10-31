#!/usr/bin/env node
// Visual audit — render every surface of the real frontend and find layout
// defects before users do (scripts/visual-audit/README.md, issue #313).
//
//   node scripts/visual-audit/audit.mjs [--engine webkit|chromium] [--scenario stress,default]
//        [--surface <name>[,<name>]] [--sizes 1280x800,1440x900,1024x700] [--out <dir>]
//
// Uses the demo-clip harness (clips.html: Tauri IPC mocked from
// scripts/clips/scenarios/) on a Vite dev server. For each scenario × surface
// it opens a fresh page, then for each window size runs the deterministic
// checks (checks.mjs) and saves a screenshot. Writes <out>/findings.json
// (merged, one entry per defect) and <out>/shots/*.png.
// Exit code: 0 = no findings, 1 = findings, 2 = the audit itself failed
// (an unknown surface, or a quarter or more of the screens crashed — a surface
// that can't render isn't a clean surface).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { inPageChecks, mergeFindings } from "./checks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const FIXED_NOW = "2026-10-28T15:00:00Z"; // scenarios/shared.ts NOW

export function parseArgs(argv) {
  const o = { engine: "webkit", scenarios: ["stress"], surfaces: null, sizes: ["1280x800", "1440x900", "1024x700"], out: join(ROOT, ".visual-audit") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { const x = argv[++i]; if (!x) throw new Error(`${a} needs a value`); return x; };
    if (a === "--engine") o.engine = v();
    else if (a === "--scenario") o.scenarios = v().split(",");
    else if (a === "--surface") o.surfaces = v().split(",");
    else if (a === "--sizes") o.sizes = v().split(",");
    else if (a === "--out") o.out = resolve(v());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!["webkit", "chromium"].includes(o.engine)) throw new Error("--engine is webkit or chromium");
  for (const s of o.sizes) if (!/^\d+x\d+$/.test(s)) throw new Error(`bad size ${s}`);
  return o;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function openHarness(context, url, scenario) {
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await page.goto(`${url}?octo-record=1&scenario=${encodeURIComponent(scenario)}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__octoClips && (window.__octoClips.ready || window.__octoClips.error), null, { timeout: 90_000 });
  const err = await page.evaluate(() => window.__octoClips.error);
  if (err) throw new Error(`harness: ${err}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let pw;
  try { pw = require("playwright"); } catch {
    console.error("visual-audit: Playwright is not installed (not a project dependency):\n  npm i --no-save playwright && npx playwright install webkit");
    return 2;
  }
  // Only ever wipe a previous audit's output, never an arbitrary --out.
  if (existsSync(opts.out) && readdirSync(opts.out).length && !existsSync(join(opts.out, "findings.json")) && !existsSync(join(opts.out, "shots"))) {
    console.error(`visual-audit: ${opts.out} isn't empty and isn't a previous audit's output — pick another --out`);
    return 2;
  }
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(join(opts.out, "shots"), { recursive: true });

  const { createServer } = await import("vite");
  const port = await freePort();
  const server = await createServer({ root: ROOT, clearScreen: false, logLevel: "warn", server: { port, strictPort: true, host: "127.0.0.1", hmr: false } });
  await server.listen();
  const url = `http://127.0.0.1:${port}/clips.html`;
  const browser = await pw[opts.engine].launch();
  const raw = [];
  const pageErrors = [];
  const visited = [];
  let unknown = 0, crashed = 0, attempted = 0;
  try {
    const [w0, h0] = opts.sizes[0].split("x").map(Number);
    const context = await browser.newContext({ viewport: { width: w0, height: h0 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
    for (const scenario of opts.scenarios) {
      const probe = await openHarness(context, url, scenario);
      const all = await probe.evaluate(() => window.__octoClips.surfaces);
      await probe.close();
      // "home" = the app as it boots (no surface opened).
      const surfaces = opts.surfaces ?? ["home", ...all];
      for (const surface of surfaces) {
        if (surface !== "home" && !all.includes(surface)) { console.error(`visual-audit: unknown surface ${surface}`); unknown++; continue; }
        attempted++;
        let page;
        // A crash = the surface couldn't be rendered and checked at all. Stray
        // page errors (an unmocked IPC call) are only logged.
        try {
          page = await openHarness(context, url, scenario);
          page.on("pageerror", (e) => pageErrors.push(`${scenario}/${surface}: ${e.message}`));
          if (surface !== "home") {
            const ok = await page.evaluate((n) => window.__octoClips.openSurface(n), surface);
            if (!ok) { console.error(`visual-audit: surface ${surface} didn't open`); unknown++; continue; }
            await page.waitForTimeout(1200);
          }
          for (const size of opts.sizes) {
            const [width, height] = size.split("x").map(Number);
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(400);
            const shot = `${scenario}--${surface.replace(/\//g, "-")}--${size}.png`;
            await page.screenshot({ path: join(opts.out, "shots", shot) });
            const found = await page.evaluate(inPageChecks);
            for (const f of found) raw.push({ ...f, surface, size, scenario, shot });
            visited.push({ scenario, surface, size, shot, findings: found.length });
          }
        } catch (e) {
          pageErrors.push(`${scenario}/${surface}: audit failed — ${e.message.split("\n")[0]}`);
          crashed++;
        } finally {
          await page?.close().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const findings = mergeFindings(raw);
  writeFileSync(join(opts.out, "findings.json"), JSON.stringify({ engine: opts.engine, scenarios: opts.scenarios, sizes: opts.sizes, visited, pageErrors, findings }, null, 2));
  console.log(`visual-audit: ${visited.length} screens (${opts.engine}), ${findings.length} distinct finding(s)`);
  for (const f of findings) console.log(`  [${f.check}] ${f.surface} @ ${f.sizes.join(",")} — ${f.selector}${f.examples[0] ? ` — "${f.examples[0]}"` : ""} (×${f.count})`);
  if (pageErrors.length) { console.log("page errors:"); for (const e of pageErrors.slice(0, 20)) console.log(`  - ${e}`); }
  if (!visited.length || unknown) return 2;
  if (attempted && crashed / attempted >= 0.25) { console.error(`visual-audit: ${crashed}/${attempted} surfaces crashed — the harness is broken, not the UI`); return 2; }
  return findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`visual-audit: ${e.message}`); process.exit(2); });
}
