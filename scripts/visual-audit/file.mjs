#!/usr/bin/env node
// File the visual audit's findings as issues (scripts/visual-audit/README.md).
//
//   node scripts/visual-audit/file.mjs <findings.json> [--dry-run]
//
// One issue per defect (fingerprint marker in the body, label `visual`):
//   - new defect            → new issue; the first READY_CAP get `ready` so the
//                             nightly builder fixes them (deterministic checks
//                             only — they can't hallucinate);
//   - defect fixed earlier  → reopened: it came back (a regression);
//   - already open, or closed as "not planned" by the owner → left alone.
// At most MAX_NEW new issues per run, so a bad night can't flood the tracker.
//
//   node scripts/visual-audit/file.mjs --design <design.json> <findings.json> [--dry-run]
//
// files the design reviewer's findings instead: validated (a real screenshot
// the agent saw, a region inside it), high/medium only, at most MAX_DESIGN a
// night and OPEN_DESIGN_CAP open, labelled `idea` + `proposal` so they show up
// in the owner's daily digest — an AI's taste never goes straight to the builder.
import { readFileSync } from "node:fs";
import { APP_REPO, makeGh, labelsOf, sanitize, reportFatal } from "../routines/gh.mjs";
import { issueTitle, issueBody, MARK, fingerprint } from "./checks.mjs";

export const MAX_NEW = 5;
export const READY_CAP = 2;
export const LABELS = ["visual", "area:app"];
export const MAX_DESIGN = 3;
export const OPEN_DESIGN_CAP = 6;  // open design proposals; past this, nothing new until some are answered
export const OPEN_VISUAL_CAP = 10; // open check-found issues; past this, nothing new
export const MAX_REOPEN = 3;
const NEEDS_OWNER = "needs-owner";
const SHOT_RE = /^shots\/[A-Za-z0-9._-]+\.png$/;
// Agent text in an issue: one line, capped, and no @mentions (they'd notify people).
const clip = (t, n) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n).replace(/@/g, "@\u200b");

/**
 * Validate the design reviewer's output against tonight's screenshots (pure,
 * tested). Returns findings shaped like the checks' (fp, surface, …) plus
 * the reviewer's text. Anything malformed is dropped, never "fixed up".
 */
export function validDesignFindings(design, visited, { size = "1280x800" } = {}) {
  // Only the screenshots the agent was given (one size).
  const shots = new Map(visited.filter((v) => v.size === size).map((v) => [`shots/${v.shot}`, v]));
  const [W, H] = size.split("x").map(Number);
  const out = [];
  for (const f of Array.isArray(design?.findings) ? design.findings.slice(0, 5) : []) {
    if (!f || !SHOT_RE.test(String(f.screenshot)) || !shots.has(f.screenshot)) continue;
    if (!["high", "medium"].includes(f.severity)) continue;
    const r = f.region ?? {};
    const nums = [r.x, r.y, r.w, r.h].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0) || nums[2] < 4 || nums[3] < 4 || nums[0] + nums[2] > W + 1 || nums[1] + nums[3] > H + 1) continue;
    const rule = clip(f.rule, 160), problem = clip(f.problem, 400), fix = clip(f.fix, 400);
    if (!rule || !problem || !fix) continue;
    const v = shots.get(f.screenshot);
    out.push({ fp: fingerprint({ check: "design", selector: `${v.surface}|${rule.toLowerCase().slice(0, 60)}` }), check: "design", surface: v.surface, rule, problem, fix, severity: f.severity, shot: v.shot, region: { x: nums[0], y: nums[1], w: nums[2], h: nums[3] } });
  }
  return out;
}

/** Issues for validated design findings (pure, tested). */
// Design issues carry `idea` for good (answers.mjs only swaps proposal/ready/later).
export const isDesign = (i) => labelsOf(i).includes("idea");
export function planDesign(findings, existing, { max = MAX_DESIGN, openCap = OPEN_DESIGN_CAP, runUrl } = {}) {
  const known = new Set(existing.map((i) => fpOf(i.body)).filter(Boolean));
  const open = existing.filter((i) => i.state === "open" && !i.pull_request && isDesign(i)).length;
  const room = Math.max(0, Math.min(max, openCap - open));
  return findings.filter((f) => !known.has(f.fp)).slice(0, room).map((f) => ({
    type: "create",
    title: `Visual design: ${clip(f.problem, 60)} (${f.surface})`.slice(0, 90),
    labels: [...LABELS, "idea", "proposal"],
    body: sanitize([
      `The nightly design review (a Claude agent reading tonight's WebKit screenshots against the design system) flagged this. It's in the daily digest: answer yes to make it \`ready\`.`,
      "",
      `**Value** ${f.severity === "high" ? "●●●●○ (4/5)" : "●●●○○ (3/5)"} · **Difficulty** S · **Estimate** 1 night · **Area** app`,
      "",
      `- **Surface:** \`${f.surface}\` · severity ${f.severity}`,
      `- **Rule:** ${f.rule}`,
      `- **Problem:** ${f.problem}`,
      `- **Suggested fix:** ${f.fix}`,
      `- **Where:** \`${f.shot}\`, region x=${f.region.x} y=${f.region.y} w=${f.region.w} h=${f.region.h}${runUrl ? ` ([screenshots](${runUrl}))` : ""}`,
    ].join("\n")) + `\n\n${MARK(f.fp)}`,
  }));
}

const FP_RE = /<!-- octopush-visual:([0-9a-f]{8}) -->/;
export const fpOf = (body) => (String(body ?? "").match(FP_RE) ?? [])[1] ?? null;

/** What to do with each finding (pure, tested). */
//   - a reopened issue loses `ready` and gets `needs-owner`: a fix that didn't
//     hold (or a check the builder can't satisfy) must not loop through the
//     builder night after night;
//   - only issues closed as *completed* are reopened (not duplicates, not
//     "not planned");
//   - new issues stop once OPEN_VISUAL_CAP check-found issues are open.
export function planFiling(findings, existing, { maxNew = MAX_NEW, readyCap = READY_CAP, maxReopen = MAX_REOPEN, openCap = OPEN_VISUAL_CAP, engine, runUrl } = {}) {
  const byFp = new Map();
  for (const i of existing) { const fp = fpOf(i.body); if (fp && !i.pull_request) byFp.set(fp, i); }
  const openChecks = existing.filter((i) => i.state === "open" && !i.pull_request && !isDesign(i));
  const openReady = openChecks.filter((i) => labelsOf(i).includes("ready")).length;
  const actions = [];
  let created = 0;
  let ready = 0;
  let reopened = 0;
  for (const f of findings) {
    const known = byFp.get(f.fp);
    if (known) {
      if (known.state === "closed" && known.state_reason === "completed" && reopened < maxReopen) {
        reopened++;
        actions.push({ type: "reopen", number: known.number, comment: `The nightly visual audit reports this again (${f.sizes.join(", ")}, ${engine ?? "WebKit"}) — it came back after the fix. Moved to \`${NEEDS_OWNER}\` so the builder doesn't loop on it.${runUrl ? ` [Audit run](${runUrl}).` : ""}` });
      }
      continue;
    }
    if (created >= maxNew || openChecks.length + created >= openCap) continue;
    created++;
    // Keep the builder's visual queue short: never more than readyCap open `ready` visual issues.
    const labels = [...LABELS];
    if (openReady + ready < readyCap) { labels.push("ready"); ready++; }
    actions.push({ type: "create", title: issueTitle(f), body: sanitize(issueBody(f, { engine, runUrl })).replace(sanitize(MARK(f.fp)), MARK(f.fp)), labels });
  }
  return actions;
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  const di = rest.indexOf("--design");
  const designFile = di >= 0 ? rest[di + 1] : null;
  const file = rest.find((a, i) => !a.startsWith("--") && (di < 0 || i !== di + 1));
  if (!file || (di >= 0 && (!designFile || designFile.startsWith("--")))) { console.error("usage: file.mjs [--design <design.json>] <findings.json> [--dry-run]"); return 64; }
  const report = JSON.parse(readFileSync(file, "utf8"));
  const gh = makeGh();
  const repo = process.env.OCTOPUSH_ROUTINE_REPO || APP_REPO;
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const existing = gh.list(`repos/${repo}/issues?state=all&labels=visual`, 2000);
  const actions = designFile
    ? planDesign(validDesignFindings(JSON.parse(readFileSync(designFile, "utf8")), report.visited ?? []), existing, { runUrl })
    : planFiling(report.findings ?? [], existing, { engine: report.engine === "webkit" ? "WebKit" : "Chromium", runUrl });
  for (const a of actions) {
    if (dry) { console.log(`[dry-run] ${a.type} ${a.number ?? a.title} ${a.labels ? `(${a.labels.join(", ")})` : ""}`); continue; }
    if (a.type === "create") {
      const i = gh.send("POST", `repos/${repo}/issues`, { title: a.title, body: a.body, labels: a.labels });
      console.log(`filed #${i.number} ${a.title} (${a.labels.join(", ")})`);
    } else {
      // Labels first: an issue must never come back open and still `ready`.
      try { gh.send("DELETE", `repos/${repo}/issues/${a.number}/labels/ready`); } catch { /* not labelled */ }
      gh.send("POST", `repos/${repo}/issues/${a.number}/labels`, { labels: [NEEDS_OWNER] });
      gh.send("PATCH", `repos/${repo}/issues/${a.number}`, { state: "open" });
      gh.send("POST", `repos/${repo}/issues/${a.number}/comments`, { body: a.comment });
      console.log(`reopened #${a.number}`);
    }
  }
  if (!actions.length) {
    const openChecks = existing.filter((i) => i.state === "open" && !i.pull_request && !isDesign(i)).length;
    const openDesign = existing.filter((i) => i.state === "open" && !i.pull_request && isDesign(i)).length;
    if (!designFile && openChecks >= OPEN_VISUAL_CAP) console.log(`::warning::visual audit: ${openChecks} open visual issues (cap ${OPEN_VISUAL_CAP}) — nothing new filed until some are fixed`);
    else if (designFile && openDesign >= OPEN_DESIGN_CAP) console.log(`::warning::design review: ${openDesign} open design ideas (cap ${OPEN_DESIGN_CAP}) — answer some in the digest`);
    else console.log("nothing new to file");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.exit(main()); } catch (e) { reportFatal("visual-audit/file", e); process.exit(1); }
}
