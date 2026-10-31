// Deterministic layout checks for the visual audit (scripts/visual-audit/README.md).
//
// `inPageChecks` runs INSIDE the page (Playwright `page.evaluate`), so it must
// be self-contained: no imports, no closures over module scope. Everything
// else here is pure and unit-tested (checks.test.mjs).

/**
 * Find layout defects on the current screen. Returns raw findings:
 *   { check, selector, text, rect: {x,y,w,h}, detail }
 * Checks:
 *   text-escapes     — visible text drawn outside the card/box that holds it (#312)
 *   text-overlap     — two unrelated pieces of text drawn on top of each other
 *   text-cut         — text clipped mid-glyph with no ellipsis (silently cut)
 *   page-scroll-x    — the window scrolls sideways
 *   unlabeled-control — a button/link with no text, title or aria-label
 */
export function inPageChecks() {
  const out = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const CLIPS = new Set(["hidden", "clip", "auto", "scroll"]);

  const visible = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      if (e.getAttribute("aria-hidden") === "true" && e !== el) return false;
    }
    return true;
  };
  // A short, stable selector: nearest data-tour / aria-label / role anchor + tag + a few classes.
  const selectorOf = (el) => {
    const parts = [];
    let anchor = null;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const t = e.getAttribute("data-tour");
      if (t) { anchor = `[data-tour="${t}"]`; break; }
      const a = e.getAttribute("aria-label");
      if (a && e !== el) { anchor = `${e.tagName.toLowerCase()}[aria-label="${a.slice(0, 40)}"]`; break; }
    }
    const cls = (el.getAttribute("class") || "").split(/\s+/)
      .filter((c) => c && !/^(hover|focus|group-hover|transition|duration|ease|animate|octo-.*-in|octo-.*-enter)/.test(c))
      .slice(0, 4).join(".");
    parts.push(el.tagName.toLowerCase() + (cls ? "." + cls : ""));
    return (anchor ? anchor + " " : "") + parts.join(" ");
  };
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const intersect = (a, b) => {
    const l = Math.max(a.left, b.left), t = Math.max(a.top, b.top);
    const r = Math.min(a.right, b.right), btm = Math.min(a.bottom, b.bottom);
    return r > l && btm > t ? { left: l, top: t, right: r, bottom: btm, width: r - l, height: btm - t } : null;
  };
  const isBox = (e) => {
    const cs = getComputedStyle(e);
    const border = ["Top", "Right", "Bottom", "Left"].some((s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== "none");
    const bg = cs.backgroundColor && !/rgba\(.*,\s*0\)$/.test(cs.backgroundColor) && cs.backgroundColor !== "transparent";
    return border || bg;
  };
  // Is this point of `el` hidden under an opaque layer (a dialog, a popover)?
  // Text under another piece of text is NOT hidden — that is an overlap.
  const alphaOf = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return 0; const p = m[1].split(","); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const opacityChain = (e) => { let o = 1; for (let x = e; x && x !== document.documentElement; x = x.parentElement) o *= Number(getComputedStyle(x).opacity); return o; };
  const opaque = (e) => {
    const ecs = getComputedStyle(e);
    return (ecs.backdropFilter && ecs.backdropFilter !== "none") || alphaOf(ecs.backgroundColor) * opacityChain(e) >= 0.9;
  };
  // At a point where two texts meet: is the lower one hidden under an opaque layer?
  const lowerHiddenAt = (x, y, a, b) => {
    const stack = document.elementsFromPoint(x, y);
    const rel = (e, t) => e === t || t.contains(e);
    const ia = stack.findIndex((e) => rel(e, a)), ib = stack.findIndex((e) => rel(e, b));
    if (ia < 0 || ib < 0) return false;
    const lowerEl = ia > ib ? a : b, lower = Math.max(ia, ib);
    // An opaque layer above the lower text that isn't part of it (e.g. the
    // dialog panel behind the upper text) hides it: not an overlap.
    for (let k = 0; k < lower; k++) if (!stack[k].contains(lowerEl) && !rel(stack[k], lowerEl) && opaque(stack[k])) return true;
    return false;
  };
  const coveredAt = (x, y, el) => {
    for (const e of document.elementsFromPoint(x, y)) {
      if (e === el || el.contains(e) || e.contains(el)) return false;
      const ecs = getComputedStyle(e);
      if (ecs.backdropFilter && ecs.backdropFilter !== "none") return true; // a frosted layer
      if (alphaOf(ecs.backgroundColor) * opacityChain(e) >= 0.9) return true;
    }
    return false;
  };

  // Text-bearing elements on screen.
  const texts = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "svg", "SVG"].includes(el.tagName)) continue;
    if (el.closest("svg, canvas, .xterm, [data-audit-ignore]")) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own.length || !visible(el)) continue;
    // Line boxes of the element's own text (not its children's).
    const lines = [];
    for (const n of own) {
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const lr of range.getClientRects()) if (lr.width > 0 && lr.height > 0) lines.push(lr);
    }
    if (!lines.length) continue;
    const r = lines.reduce((a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) }));
    r.width = r.right - r.left; r.height = r.bottom - r.top;
    // What the user can actually see: the text clipped by every clipping ancestor.
    let seen = r;
    let clip = null;
    let boxEl = null;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (!boxEl && isBox(e)) boxEl = e;
      if (CLIPS.has(cs.overflowX) || CLIPS.has(cs.overflowY)) {
        const er = e.getBoundingClientRect();
        clip = clip ? intersect(clip, er) : er;
        seen = intersect(seen, er);
        if (!seen) break;
      }
    }
    if (!seen || seen.right < 0 || seen.left > vw || seen.bottom < 0 || seen.top > vh) continue;
    if (coveredAt((seen.left + seen.right) / 2, (seen.top + seen.bottom) / 2, el)) continue;
    const text = own.map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim().slice(0, 60);
    texts.push({ el, seen, text, lines: lines.map((l) => (clip ? intersect(l, clip) : l)).filter(Boolean) });

    if (boxEl) {
      const b = boxEl.getBoundingClientRect();
      const by = Math.max(seen.right - b.right, b.left - seen.left, seen.bottom - b.bottom, b.top - seen.top);
      if (by > 2) out.push({ check: "text-escapes", selector: selectorOf(el), group: selectorOf(boxEl), text, rect: box(seen), detail: `drawn ${Math.round(by)}px outside its box (${selectorOf(boxEl)})` });
    }
    const cs = getComputedStyle(el);
    if (CLIPS.has(cs.overflowX) && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 2 && cs.whiteSpace.startsWith("nowrap")) {
      out.push({ check: "text-cut", selector: selectorOf(el), text, rect: box(seen), detail: `${el.scrollWidth - el.clientWidth}px of text hidden with no ellipsis` });
    }
  }

  // Overlaps between unrelated text.
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], b = texts[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (!intersect(a.seen, b.seen)) continue;
      let hit = null;
      for (const la of a.lines) for (const lb of b.lines) {
        const x = intersect(la, lb);
        if (!x || x.width <= 3 || x.height <= 3) continue;
        const smaller = Math.min(la.width * la.height, lb.width * lb.height);
        if (x.width * x.height > 0.2 * smaller && !lowerHiddenAt((x.left + x.right) / 2, (x.top + x.bottom) / 2, a.el, b.el)) { hit = x; break; }
      }
      let common = a.el.parentElement;
      while (common && !common.contains(b.el)) common = common.parentElement;
      if (hit) out.push({ check: "text-overlap", selector: selectorOf(a.el), group: common ? selectorOf(common) : "", text: `${a.text} ⨯ ${b.text}`, rect: box(hit), detail: `overlaps ${selectorOf(b.el)}` });
    }
  }

  const se = document.scrollingElement;
  if (se && se.scrollWidth > vw + 1) out.push({ check: "page-scroll-x", selector: "html", text: "", rect: { x: 0, y: 0, w: vw, h: vh }, detail: `page is ${se.scrollWidth - vw}px wider than the window` });

  for (const el of document.body.querySelectorAll("button, a[href], [role=button]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) continue;
    if (coveredAt((r.left + r.right) / 2, (r.top + r.bottom) / 2, el)) continue;
    const name = (el.textContent || "").trim() || el.getAttribute("title") || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
    if (!name) out.push({ check: "unlabeled-control", selector: selectorOf(el), text: "", rect: box(r), detail: "no text, title or aria-label (needs a tooltip)" });
  }
  return out;
}

// ─── Pure helpers (tested) ───────────────────────────────────────────────

/**
 * Stable identity of a defect, whatever the fixture text, window size or
 * surface: the check plus the element it happens in — for text escaping, the
 * box it escapes; for overlaps, the container both texts share (so the mode
 * switcher colliding with the header's status line is ONE defect on every
 * surface that shows that header).
 */
export function fingerprint(f) {
  const s = `${f.check}|${f.group || f.selector}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Merge raw findings across viewports and repeated elements into one entry per
 * fingerprint: { fp, check, surface, selector, detail, examples[], sizes[], count, shots[] }.
 */
export function mergeFindings(raw) {
  const by = new Map();
  for (const f of raw) {
    const fp = fingerprint(f);
    const m = by.get(fp) ?? { fp, check: f.check, surface: f.surface, surfaces: [], selector: f.selector, group: f.group || f.selector, detail: f.detail, examples: [], sizes: [], scenarios: [], count: 0, shots: [] };
    m.count++;
    if (!m.surfaces.includes(f.surface)) m.surfaces.push(f.surface);
    if (f.text && m.examples.length < 3 && !m.examples.includes(f.text)) m.examples.push(f.text);
    if (!m.sizes.includes(f.size)) m.sizes.push(f.size);
    if (f.scenario && !m.scenarios.includes(f.scenario)) m.scenarios.push(f.scenario);
    if (f.shot && m.shots.length < 2 && !m.shots.some((s) => s.file === f.shot)) m.shots.push({ file: f.shot, rect: f.rect });
    by.set(fp, m);
  }
  const order = ["text-escapes", "text-overlap", "page-scroll-x", "text-cut", "unlabeled-control"];
  return [...by.values()].sort((a, b) => order.indexOf(a.check) - order.indexOf(b.check) || a.surface.localeCompare(b.surface));
}

export const CHECK_TITLES = {
  "text-escapes": "Text runs outside its box",
  "text-overlap": "Text drawn over other text",
  "text-cut": "Text cut off without an ellipsis",
  "page-scroll-x": "Window scrolls sideways",
  "unlabeled-control": "Control without a label or tooltip",
};

/** One-line issue title (≤ 90 chars, like every routine title). */
export function issueTitle(m) {
  const where = (m.surfaces?.length ?? 1) > 1 ? `${m.surface} +${m.surfaces.length - 1}` : m.surface;
  const t = `Visual: ${CHECK_TITLES[m.check] ?? m.check} (${where})`;
  return t.length <= 90 ? t : t.slice(0, 89) + "…";
}

export const MARK = (fp) => `<!-- octopush-visual:${fp} -->`;

/** The issue body: what, where, how to reproduce, what done means. */
export function issueBody(m, { engine, runUrl } = {}) {
  const lines = [
    `The nightly visual audit found this in **${engine ?? "WebKit"}** (the engine Octopush uses on macOS).`,
    "",
    `- **Check:** ${CHECK_TITLES[m.check] ?? m.check} — ${m.detail}`,
    `- **Surfaces:** ${m.surfaces.map((x) => `\`${x}\``).join(", ")} · window ${m.sizes.join(", ")} · scenario ${m.scenarios.join(", ")}`,
    `- **Element:** \`${m.selector.replace(/`/g, "'")}\`${m.group !== m.selector ? ` in \`${m.group.replace(/`/g, "'")}\`` : ""} (${m.count} occurrence${m.count === 1 ? "" : "s"})`,
  ];
  if (m.examples.length) lines.push(`- **Text:** ${m.examples.map((e) => `"${e.replace(/[`<>]/g, "")}"`).join(", ")}`);
  if (runUrl) lines.push(`- **Screenshots:** artifact of [this audit run](${runUrl})`);
  lines.push(
    "",
    "## Reproduce",
    "",
    "```bash",
    `node scripts/visual-audit/audit.mjs --engine webkit --surface ${m.surface} --scenario ${m.scenarios[0] ?? "stress"}`,
    "```",
    "",
    "## Done when",
    "",
    "- The next nightly audit no longer reports it (if it comes back after the fix, the audit reopens this issue).",
    "- The fix is the general one (the pattern, not just this string); other places with the same pattern are fixed too.",
    "- A Vitest test pins the classes/structure that make it hold.",
    "",
    MARK(m.fp),
  );
  return lines.join("\n");
}
