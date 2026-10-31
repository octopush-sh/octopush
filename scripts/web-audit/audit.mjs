#!/usr/bin/env node
// Web audit — render every page of the built website (octopush-web) and find
// layout, copy and wiring defects before visitors do (scripts/web-audit/README.md).
//
//   node scripts/web-audit/audit.mjs --site <octopush-web checkout, already built>
//        [--page /docs/x/[,/…]] [--sizes 1440x900,1024x700,390x844] [--out <dir>] [--offline]
//
// Serves <site>/dist on a local port, opens each page in Playwright Chromium at
// each window size, runs the app audit's layout checks (visual-audit/checks.mjs
// `inPageChecks`) and the website checks (checks.mjs `webInPageChecks`), saves
// a screenshot, and checks every internal link and #anchor from the built HTML.
// Writes <out>/findings.json (merged, one entry per defect) and <out>/shots/.
// Exit code: 0 = no findings, 1 = findings, 2 = the audit itself failed.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { inPageChecks, mergeFindings } from "../visual-audit/checks.mjs";
import { webInPageChecks, pagesFromDist, fileFor, linkFindings, readPages, routedPaths, WEB_SIZES } from "./checks.mjs";

const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const o = { site: null, pages: null, sizes: WEB_SIZES, out: resolve(".web-audit"), offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { const x = argv[++i]; if (!x) throw new Error(`${a} needs a value`); return x; };
    if (a === "--site") o.site = resolve(v());
    else if (a === "--page") o.pages = v().split(",");
    else if (a === "--sizes") o.sizes = v().split(",");
    else if (a === "--out") o.out = resolve(v());
    else if (a === "--offline") o.offline = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.site) throw new Error("--site <octopush-web checkout> is required");
  for (const s of o.sizes) if (!/^\d+x\d+$/.test(s)) throw new Error(`bad size ${s}`);
  return o;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".woff2": "font/woff2", ".txt": "text/plain", ".xml": "application/xml", ".ico": "image/x-icon", ".wasm": "application/wasm" };

/** A static server for dist/ (directory URLs → index.html, 404.html otherwise). */
function serve(dist) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const file = fileFor(dist, path);
    const fallback = join(dist, "404.html");
    const f = file ?? (existsSync(fallback) ? fallback : null);
    res.writeHead(file ? 200 : 404, { "content-type": TYPES[extname(f ?? "")] ?? "application/octet-stream" });
    res.end(f ? readFileSync(f) : "not found");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const shotName = (path, size) => `${path === "/" ? "home" : path.replace(/^\/|\/$/g, "").replace(/[^A-Za-z0-9._-]+/g, "-")}--${size}.png`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dist = join(opts.site, "dist");
  if (!existsSync(dist) || !statSync(dist).isDirectory()) { console.error(`web-audit: ${dist} not found — run \`npm run build\` in the site first`); return 2; }
  let pw;
  try { pw = require("playwright"); } catch {
    console.error("web-audit: Playwright is not installed (not a project dependency):\n  npm i --no-save playwright && npx playwright install chromium");
    return 2;
  }
  if (existsSync(opts.out) && readdirSync(opts.out).length && !existsSync(join(opts.out, "findings.json")) && !existsSync(join(opts.out, "shots"))) {
    console.error(`web-audit: ${opts.out} isn't empty and isn't a previous audit's output — pick another --out`);
    return 2;
  }
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(join(opts.out, "shots"), { recursive: true });

  const all = pagesFromDist(dist);
  const pages = opts.pages ?? all;
  const unknown = pages.filter((p) => !all.includes(p));
  if (unknown.length) { console.error(`web-audit: not pages of the site: ${unknown.join(", ")}`); return 2; }
  const vercel = join(opts.site, "vercel.json");
  const raw = linkFindings(readPages(dist, all).filter((p) => pages.includes(p.path)), { dist, routes: existsSync(vercel) ? routedPaths(readFileSync(vercel, "utf8")) : [] });

  const server = await serve(dist);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await pw.chromium.launch();
  const visited = [], pageErrors = [];
  let crashed = 0;
  try {
    const [w0, h0] = opts.sizes[0].split("x").map(Number);
    const context = await browser.newContext({ viewport: { width: w0, height: h0 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
    // --offline: only the local server (fonts fall back; layout may differ from production).
    if (opts.offline) await context.route((url) => !url.href.startsWith(base), (r) => r.abort());
    for (const path of pages) {
      const page = await context.newPage();
      page.on("pageerror", (e) => pageErrors.push(`${path}: ${e.message}`));
      try {
        await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 60_000 });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        for (const size of opts.sizes) {
          const [width, height] = size.split("x").map(Number);
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(300);
          const shot = shotName(path, size);
          await page.screenshot({ path: join(opts.out, "shots", shot) });
          const found = [...(await page.evaluate(inPageChecks)), ...(await page.evaluate(webInPageChecks))];
          for (const f of found) raw.push({ ...f, surface: path, size, scenario: "site", shot });
          visited.push({ scenario: "site", surface: path, size, shot, findings: found.length });
        }
      } catch (e) {
        pageErrors.push(`${path}: audit failed — ${e.message.split("\n")[0]}`);
        crashed++;
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  // Link findings have no window size; give them the page's first.
  const findings = mergeFindings(raw.map((f) => ({ size: "", scenario: "site", ...f })));
  writeFileSync(join(opts.out, "findings.json"), JSON.stringify({ engine: "chromium", target: "web", sizes: opts.sizes, pages, visited, pageErrors, findings }, null, 2));
  console.log(`web-audit: ${pages.length} pages × ${opts.sizes.length} sizes (chromium), ${findings.length} distinct finding(s)`);
  for (const f of findings) console.log(`  [${f.check}] ${f.surface}${f.surfaces.length > 1 ? ` +${f.surfaces.length - 1}` : ""} @ ${f.sizes.filter(Boolean).join(",") || "-"} — ${f.selector}${f.examples[0] ? ` — "${f.examples[0]}"` : ""} (×${f.count})`);
  if (process.env.GITHUB_ACTIONS === "true") {
    const kinds = [...new Set(findings.map((f) => f.check))].join(", ") || "none";
    console.log(`::notice title=web-audit::${pages.length} pages, ${findings.length} finding(s) [${kinds}], ${pageErrors.length} page error(s)`);
  }
  if (pageErrors.length) { console.log("page errors:"); for (const e of pageErrors.slice(0, 20)) console.log(`  - ${e}`); }
  if (!visited.length) return 2;
  if (crashed / pages.length >= 0.25) { console.error(`web-audit: ${crashed}/${pages.length} pages failed to load — the audit is broken, not the site`); return 2; }
  return findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`web-audit: ${e.message}`); process.exit(2); });
}
