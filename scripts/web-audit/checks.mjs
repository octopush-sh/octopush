// Website checks for the nightly web audit (scripts/web-audit/README.md).
//
// `webInPageChecks` runs INSIDE the page (Playwright `page.evaluate`), like
// scripts/visual-audit/checks.mjs `inPageChecks` (which the audit runs too), so
// it must be self-contained: no imports, no closures over module scope.
// Everything else here is pure and unit-tested (web-audit.test.mjs).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { MARK } from "../visual-audit/checks.mjs";

/**
 * Website defects on the current screen. Returns raw findings in the visual
 * audit's shape: { check, selector, group?, text, rect, detail }.
 *   offscreen-x      — an element runs past the window's right edge (even when
 *                      the page hides the overflow: then it's simply cut off)
 *   placeholder-text — visible "[screenshot", "TODO" or "Lorem" left in the copy
 *   retired-glyph    — §, ✦, or ⟶ outside a link/button (CLAUDE.md rule 5)
 *   italic-text      — text drawn in an italic or oblique face (italics are retired)
 *   missing-meta     — no <title>, meta description, og:title, og:description or og:image
 */
export function webInPageChecks() {
  const out = [];
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  // Hidden: display/visibility/opacity, aria-hidden, clipped to nothing (a
  // skip link, an sr-only label), or inside a closed <details> (not its summary).
  const visible = (el) => {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    for (let e = el, prev = null; e && e !== document.documentElement; prev = e, e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      if (e.getAttribute("aria-hidden") === "true") return false;
      if (cs.clip === "rect(0px, 0px, 0px, 0px)" || /inset\(50%\)/.test(cs.clipPath)) return false;
      if (e.tagName === "DETAILS" && !e.open && prev && prev.tagName !== "SUMMARY") return false;
    }
    return true;
  };
  // Stable across pages: the nearest id-less landmark or class chain, never text.
  const selectorOf = (el) => {
    const part = (e) => {
      const cls = (e.getAttribute("class") || "").split(/\s+/).filter((c) => c && !/^(astro-|is-|active|current|hover|focus)/.test(c)).slice(0, 3).join(".");
      return e.tagName.toLowerCase() + (cls ? "." + cls : "");
    };
    const parts = [part(el)];
    for (let e = el.parentElement, k = 0; e && e !== document.body && k < 2; e = e.parentElement, k++) {
      if (["MAIN", "HEADER", "FOOTER", "NAV", "ASIDE", "SECTION", "ARTICLE"].includes(e.tagName) || e.id) { parts.unshift(e.id && !/\d/.test(e.id) ? `#${e.id}` : part(e)); break; }
      parts.unshift(part(e));
    }
    return parts.join(" > ");
  };
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const inCode = (el) => !!el.closest("pre, code, kbd, samp, script, style, noscript, template, svg, [data-audit-ignore]");

  // 1. Content (text, images, controls) that starts on screen and runs past the
  // right edge — unless an ancestor other than html/body clips or scrolls it
  // inside the window. An empty box that is merely wide draws nothing: not a defect.
  const CLIPS = new Set(["hidden", "clip", "auto", "scroll"]);
  const contained = (el) => {
    for (let e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (CLIPS.has(getComputedStyle(e).overflowX) && e.getBoundingClientRect().right <= vw + 1) return true;
    }
    return false;
  };
  const past = (r) => r.width > 0 && r.height > 0 && r.left < vw - 1 && r.right > vw + 1 && r.bottom > 0 && r.top < vh * 4;
  const offenders = new Map();
  for (const el of document.body.querySelectorAll("*")) {
    if (el.closest("svg, [data-audit-ignore]") && el.tagName !== "svg") continue;
    // A code block may scroll sideways inside itself.
    if (el.closest("pre") && el.tagName !== "PRE") continue;
    const replaced = /^(IMG|SVG|svg|VIDEO|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON|IFRAME|PICTURE)$/.test(el.tagName);
    let rect = null;
    if (replaced) { const r = el.getBoundingClientRect(); if (past(r)) rect = r; }
    else {
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const lr of range.getClientRects()) if (past(lr)) { rect = lr; break; }
        if (rect) break;
      }
    }
    if (!rect || !visible(el) || contained(el)) continue;
    // One finding per block that holds the content (its nearest non-inline ancestor).
    let block = el;
    while (block.parentElement && block !== document.body && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    if (!offenders.has(block)) offenders.set(block, rect);
  }
  for (const [el, rect] of offenders) {
    if ([...offenders.keys()].some((o) => o !== el && o.contains(el))) continue;
    out.push({ check: "offscreen-x", selector: selectorOf(el), text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60), rect: box(rect), detail: `content ends ${Math.round(rect.right - vw)}px past a ${vw}px window` });
  }

  // 2–4. Text: placeholders, retired glyphs, italics.
  const PLACEHOLDER = [/\[screenshot/i, /\bTODO\b/, /\blorem\b/i];
  const seen = new Set();
  for (const el of document.body.querySelectorAll("*")) {
    if (inCode(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own.length || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const text = own.map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
    const sel = selectorOf(el);
    const m = PLACEHOLDER.map((re) => re.exec(text)).find(Boolean);
    if (m) out.push({ check: "placeholder-text", selector: sel, text: text.slice(0, 60), rect: box(r), detail: `placeholder copy "${m[0]}" is visible` });
    // ⟶ survives only as the existing CTA/link forward arrow (CLAUDE.md rule 5).
    const glyphs = [...new Set((text.match(/[§✦⟶]/g) || []).filter((g) => g !== "⟶" || !el.closest("a, button")))];
    // One defect per glyph, wherever it shows: the fix is the same sweep.
    if (glyphs.length) out.push({ check: "retired-glyph", selector: sel, group: `glyph ${glyphs.join(" ")}`, text: text.slice(0, 60), rect: box(r), detail: `retired glyph ${glyphs.join(" ")} in visible text` });
    const fs = getComputedStyle(el).fontStyle;
    // One defect per element kind (every <em> styled italic is one stylesheet rule).
    if (/italic|oblique/.test(fs) && !seen.has(sel)) { seen.add(sel); out.push({ check: "italic-text", selector: sel, group: `font-style ${el.tagName.toLowerCase()}`, text: text.slice(0, 60), rect: box(r), detail: `<${el.tagName.toLowerCase()}> is drawn ${fs}` }); }
  }

  // 5. What search engines and link previews read.
  const meta = (q) => (document.head.querySelector(q)?.getAttribute("content") || "").trim();
  const need = [
    ["<title>", (document.title || "").trim()],
    ['meta[name="description"]', meta('meta[name="description"]')],
    ['meta[property="og:title"]', meta('meta[property="og:title"]')],
    ['meta[property="og:description"]', meta('meta[property="og:description"]')],
    ['meta[property="og:image"]', meta('meta[property="og:image"]')],
  ];
  const robots = meta('meta[name="robots"]');
  const missing = need.filter(([, v]) => !v).map(([what]) => what.replace(/^meta\[(?:name|property)="([^"]+)"\]$/, "$1"));
  // One defect per page template: the layout that leaves them out.
  if (!/noindex/i.test(robots) && missing.length) out.push({ check: "missing-meta", selector: "head", text: missing.join(", "), rect: { x: 0, y: 0, w: vw, h: vh }, detail: `no ${missing.join(", ")}` });
  return out;
}

// ─── Pure helpers (tested) ───────────────────────────────────────────────

export const WEB_CHECK_TITLES = {
  "text-escapes": "Text runs outside its box",
  "text-overlap": "Text drawn over other text",
  "text-cut": "Text cut off without an ellipsis",
  "page-scroll-x": "Page scrolls sideways",
  "unlabeled-control": "Link or button without a label",
  "offscreen-x": "Content runs past the window edge",
  "placeholder-text": "Placeholder copy is visible",
  "retired-glyph": "Retired glyph in visible text",
  "italic-text": "Italic text (italics are retired)",
  "missing-meta": "Missing title, description or social-card tag",
  "broken-link": "Internal link to a page that doesn't exist",
  "missing-anchor": "Link to a heading that doesn't exist",
};
/** Checks that are about content and wiring rather than layout: labelled `bug` too. */
export const BUG_CHECKS = new Set(["broken-link", "missing-anchor", "missing-meta", "placeholder-text"]);
export const WEB_SIZES = ["1440x900", "1024x700", "390x844"];

/**
 * Every page of a built site: dist/**.html, as URL paths (pure over the file
 * system). `docs/a/index.html` → `/docs/a/`; `404.html` → `/404.html`. Pagefind's
 * and Astro's asset folders are not pages.
 */
export function pagesFromDist(dist) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(dist, p).split(sep).join("/");
      if (/^(pagefind|_astro)(\/|$)/.test(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".html")) out.push(rel === "index.html" ? "/" : rel.endsWith("/index.html") ? `/${rel.slice(0, -"index.html".length)}` : `/${rel}`);
    }
  };
  walk(dist);
  return out.sort();
}

/** The file a URL path is served from (null if none). Directory URLs with or without the slash. */
export function fileFor(dist, path) {
  const clean = decodeURIComponent(path.split(/[?#]/)[0]).replace(/\/+/g, "/");
  if (clean.split("/").includes("..")) return null;
  const cands = clean.endsWith("/") ? [`${clean}index.html`] : [clean, `${clean}/index.html`, `${clean}.html`];
  for (const c of cands) { const f = join(dist, c); if (existsSync(f) && statSync(f).isFile()) return f; }
  return null;
}

/** Paths Vercel answers without a file in dist/ (rewrites and redirects in vercel.json). */
export function routedPaths(vercelJson) {
  let v;
  try { v = JSON.parse(vercelJson); } catch { return []; }
  return [...(v?.rewrites ?? []), ...(v?.redirects ?? [])].map((r) => String(r.source ?? "")).filter((s) => s.startsWith("/"));
}
const routeMatches = (routes, path) => routes.some((src) => {
  const re = new RegExp(`^${src.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\/:[\w]+\*/g, "(?:/.*)?").replace(/:[\w]+/g, "[^/]+")}/?$`);
  return re.test(path);
});

const SITE = /^https?:\/\/(www\.)?octopush\.sh(?=\/|$)/i;
const ids = (html) => new Set([...html.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));

/**
 * Internal links that lead nowhere, from the built HTML (pure over `pages`:
 * [{ path, html }]). A link is internal when it is relative, root-relative or
 * on octopush.sh. Its page must exist (a dist file, or a vercel.json route) and
 * its #fragment must be an id on that page. Raw findings, one per link and
 * page, in the visual audit's shape — merged later into one issue per target.
 */
export function linkFindings(pages, { dist, routes = [] } = {}) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const idCache = new Map();
  const idsOf = (p) => { if (!idCache.has(p.path)) idCache.set(p.path, ids(p.html)); return idCache.get(p.path); };
  const out = [];
  for (const page of pages) {
    for (const raw of new Set(hrefs(page.html))) {
      if (!raw || /^(mailto:|tel:|javascript:|data:)/i.test(raw) || raw.startsWith("//")) continue;
      let href = raw;
      if (/^https?:/i.test(href)) { if (!SITE.test(href)) continue; href = href.replace(SITE, "") || "/"; }
      let url;
      try { url = new URL(href, `https://octopush.sh${page.path}`); } catch { continue; }
      const path = url.pathname, frag = decodeURIComponent(url.hash.slice(1));
      const target = path === page.path ? page : byPath.get(path) ?? byPath.get(path.endsWith("/") ? path : `${path}/`);
      const file = target ? null : dist ? fileFor(dist, path) : null;
      if (!target && !file && !routeMatches(routes, path)) {
        out.push({ check: "broken-link", selector: `a[href="${path}"]`, text: raw.slice(0, 60), rect: { x: 0, y: 0, w: 0, h: 0 }, detail: `${path} is not a page or file of the site`, surface: page.path });
        continue;
      }
      if (frag && frag !== "_top" && target && !idsOf(target).has(frag)) {
        out.push({ check: "missing-anchor", selector: `a[href="${path}#${frag}"]`, text: raw.slice(0, 60), rect: { x: 0, y: 0, w: 0, h: 0 }, detail: `${path} has no element with id "${frag}"`, surface: page.path });
      }
    }
  }
  return out;
}

/** Read every page's HTML from dist (for linkFindings). */
export const readPages = (dist, paths) => paths.map((path) => ({ path, html: readFileSync(fileFor(dist, path), "utf8") }));

/** One-line issue title (≤ 90 chars). */
export function webIssueTitle(m) {
  const where = (m.surfaces?.length ?? 1) > 1 ? `${m.surface} +${m.surfaces.length - 1}` : m.surface;
  const t = `Website: ${WEB_CHECK_TITLES[m.check] ?? m.check} (${where})`;
  return t.length <= 90 ? t : t.slice(0, 89) + "…";
}

/** The issue body: what, where, how to reproduce, what done means. */
export function webIssueBody(m, { runUrl } = {}) {
  // Page text is data: no backticks breaking the code spans, no @mentions notifying anyone.
  const tick = (s) => String(s).replace(/`/g, "'").replace(/@/g, "@\u200b");
  const pages = m.surfaces.slice(0, 12).map((x) => `\`${tick(x)}\``).join(", ") + (m.surfaces.length > 12 ? ` and ${m.surfaces.length - 12} more` : "");
  const lines = [
    "The nightly web audit (`web-audit.yml` in octopush-sh/octopush) found this on the built site, in **Chromium**.",
    "",
    `- **Check:** ${WEB_CHECK_TITLES[m.check] ?? m.check} — \`${tick(m.detail)}\``,
    `- **Pages:** ${pages} · window ${m.sizes.filter(Boolean).join(", ") || "any"}`,
    `- **Element:** \`${tick(m.selector)}\`${m.group !== m.selector ? ` in \`${tick(m.group)}\`` : ""} (${m.count} occurrence${m.count === 1 ? "" : "s"})`,
  ];
  if (m.examples.length) lines.push(`- **Text:** ${m.examples.map((e) => `"${e.replace(/[`<>]/g, "").replace(/@/g, "@\u200b")}"`).join(", ")}`);
  if (runUrl) lines.push(`- **Screenshots:** artifact of [this audit run](${runUrl})`);
  lines.push(
    "",
    "## Reproduce",
    "",
    "```bash",
    "npm ci && npm run build",
    "# from a checkout of octopush-sh/octopush next to this one:",
    `node ../octopush/scripts/web-audit/audit.mjs --site . --page ${tick(m.surface)}`,
    "```",
    "",
    "## Done when",
    "",
    "- The next nightly web audit no longer reports it (if it comes back after the fix, the audit reopens this issue).",
    "- Fixed in the page or component, with tokens and the design rules in CLAUDE.md; other pages with the same pattern are fixed too.",
    "- Every claim on a touched page is still true of the current stable app.",
    "",
    MARK(m.fp),
  );
  return lines.join("\n");
}
