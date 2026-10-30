#!/usr/bin/env node
// Apply the owner's answers to the ideas digest (VISION.md §9).
//
//   answers.mjs check   exit 0 when an open digest has an owner comment not applied yet
//   answers.mjs apply   apply every unapplied owner comment and reply with a summary
//
// Grammar (one instruction per line or ';'; case and accents don't matter):
//   1 yes | 2 no | 3 later        also sí/si/ok/dale, aún no/luego/después/not yet;
//   1, 4 y 6 sí — una nota        several numbers; text after the verb is a note
//   merge web#12 | merge api#5    merge a waiting website/API PR (CI must be green)
//   promote 0.4.91                dispatch the stable promotion workflow
//   idea: <text>                  file a new idea for tomorrow's digest to estimate
import { makeGh, APP_REPO, API_REPO, WEB_REPO, ciStatus } from "./gh.mjs";

const MARK = "<!-- octopush-";
const YES = ["si", "yes", "y", "ok", "dale", "aprobado", "approve"];
const NO = ["no", "n", "nope", "descartar", "reject"];
const LATER = ["aun no", "later", "luego", "despues", "mas tarde", "not yet", "todavia no"];

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Parse one comment into actions. Pure. */
export function parseAnswers(text) {
  const actions = [], unknown = [];
  const verbs = [...YES, ...NO, ...LATER].sort((a, b) => b.length - a.length).map((v) => v.replace(/ /g, "\\s+")).join("|");
  const item = new RegExp(`^((?:\\d+\\s*(?:,|y|and|&|\\s)\\s*)*\\d+)\\s*[:.)\\-]?\\s*(${verbs})\\b\\s*[:,\\-—–]?\\s*(.*)$`);
  for (const raw of text.split(/\r?\n|;/)) {
    const line = raw.replace(/^\s*(?:[-*>]|\d+\.(?=\s+\d))\s*/, "").trim();
    if (!line) continue;
    const f = fold(line);
    let m;
    if ((m = item.exec(f))) {
      const verb = m[2].replace(/\s+/g, " ");
      const verdict = YES.includes(verb) ? "yes" : NO.includes(verb) ? "no" : "later";
      const note = line.slice(line.length - m[3].length).trim();
      for (const n of m[1].match(/\d+/g)) actions.push({ type: "verdict", n: Number(n), verdict, note });
    } else if ((m = /^(?:merge|mergea|mergear)\s+(?:octopush-)?(web|api)\s*#\s*(\d+)\b/.exec(f))) {
      actions.push({ type: "merge", repo: m[1] === "web" ? WEB_REPO : API_REPO, n: Number(m[2]) });
    } else if ((m = /^(?:promote|promover|promueve)\s+v?(\d+\.\d+\.\d+)\b/.exec(f))) {
      actions.push({ type: "promote", version: m[1] });
    } else if ((m = /^idea\s*:\s*(.+)$/i.exec(line))) {
      actions.push({ type: "idea", text: m[1].trim() });
    } else {
      unknown.push(line);
    }
  }
  return { actions, unknown };
}

export const digestMap = (body) => {
  const m = /<!-- octopush-digest:(\{.*?\}) -->/.exec(body ?? "");
  return m ? JSON.parse(m[1]) : {};
};
const appliedIds = (comments) => new Set(comments.flatMap((c) => [...(c.body ?? "").matchAll(/<!-- octopush-applied:(\d+) -->/g)].map((m) => m[1])));

/** Owner comments on a digest that haven't been applied. */
export function pending(comments, viewer) {
  const done = appliedIds(comments);
  return comments.filter((c) => c.user?.login === viewer && !(c.body ?? "").includes(MARK) && !done.has(String(c.id)));
}

function splitRef(ref) {
  const [repo, n] = ref.split("#");
  return { repo, n: Number(n) };
}

function applyOne(gh, digest, action) {
  const link = `[${digest.title}](${digest.html_url})`;
  if (action.type === "verdict") {
    const ref = digestMap(digest.body)[String(action.n)];
    if (!ref) return `#${action.n}: no such item in this digest`;
    const { repo, n } = splitRef(ref);
    const note = action.note ? `\n\n> ${action.note}` : "";
    const drop = (label) => { try { gh.send("DELETE", `repos/${repo}/issues/${n}/labels/${label}`); } catch { /* absent */ } };
    if (action.verdict === "yes") {
      gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["ready"] });
      drop("proposal"); drop("later");
      gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Approved by the owner in ${link} — the nightly builders will pick it up.${note}` });
      return `${action.n} → **ready** (${ref})`;
    }
    if (action.verdict === "no") {
      gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["wontfix"] });
      gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Declined by the owner in ${link}.${note}` });
      gh.send("PATCH", `repos/${repo}/issues/${n}`, { state: "closed", state_reason: "not_planned" });
      return `${action.n} → closed (${ref})`;
    }
    gh.send("POST", `repos/${repo}/issues/${n}/labels`, { labels: ["later"] });
    drop("proposal");
    gh.send("POST", `repos/${repo}/issues/${n}/comments`, { body: `Parked as **later** by the owner in ${link}; it may come back in a month.${note}` });
    return `${action.n} → later (${ref})`;
  }
  if (action.type === "merge") {
    const pr = gh.get(`repos/${action.repo}/pulls/${action.n}`);
    const short = action.repo.endsWith("-web") ? "web" : "api";
    if (pr.state !== "open") return `merge ${short}#${action.n}: not open`;
    const ci = ciStatus(gh, action.repo, pr.head.sha);
    if (ci !== "success") return `merge ${short}#${action.n}: CI is ${ci} — not merged`;
    const r = gh.send("PUT", `repos/${action.repo}/pulls/${action.n}/merge`, { merge_method: "merge", sha: pr.head.sha });
    return r?.merged ? `merged ${short}#${action.n} (it deploys at the next deploy window)` : `merge ${short}#${action.n}: ${r?.message ?? "failed"}`;
  }
  if (action.type === "promote") {
    try {
      gh.send("POST", `repos/${APP_REPO}/actions/workflows/promote.yml/dispatches`, { ref: "main", inputs: { version: action.version } });
      return `promotion of ${action.version} to stable started`;
    } catch (e) {
      return `promote ${action.version}: could not start the promote workflow (${String(e.message).split("\n")[0]})`;
    }
  }
  if (action.type === "idea") {
    const title = action.text.length > 80 ? `${action.text.slice(0, 77)}…` : action.text;
    const i = gh.send("POST", `repos/${APP_REPO}/issues`, {
      title, labels: ["proposal", "idea", "owner-idea"],
      body: `${action.text}\n\n_Added by the owner in ${link}. Tomorrow's digest estimates its value, difficulty and time._`,
    });
    return `new idea filed: #${i.number}`;
  }
  return "unknown action";
}

export function applyAll(gh, viewer) {
  const digests = gh.list(`repos/${APP_REPO}/issues?state=all&labels=digest&sort=created&direction=desc`, 5);
  let applied = 0;
  for (const d of digests) {
    const comments = gh.list(`repos/${APP_REPO}/issues/${d.number}/comments`);
    for (const c of pending(comments, viewer)) {
      const { actions, unknown } = parseAnswers(c.body ?? "");
      const results = actions.map((a) => { try { return applyOne(gh, d, a); } catch (e) { return `${a.type}: error — ${String(e.message).split("\n")[0]}`; } });
      const lines = [...results.map((r) => `- ${r}`), ...unknown.map((u) => `- didn't understand: “${u}”`)];
      gh.send("POST", `repos/${APP_REPO}/issues/${d.number}/comments`, {
        body: `${lines.length ? lines.join("\n") : "- nothing to apply"}\n\n<!-- octopush-applied:${c.id} -->`,
      });
      applied++;
    }
  }
  return applied;
}

async function main() {
  const cmd = process.argv[2];
  const gh = makeGh();
  const viewer = gh.viewer();
  if (cmd === "check") {
    const digests = gh.list(`repos/${APP_REPO}/issues?state=all&labels=digest&sort=created&direction=desc`, 5);
    for (const d of digests) {
      if (pending(gh.list(`repos/${APP_REPO}/issues/${d.number}/comments`), viewer).length) { console.log(`answers waiting on #${d.number}`); return 0; }
    }
    console.log("no new answers");
    return 1;
  }
  if (cmd === "apply") { console.log(`applied ${applyAll(gh, viewer)} comment(s)`); return 0; }
  console.error("usage: answers.mjs check | apply");
  return 64;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`answers: ${e.message}`); process.exit(2); });
}
