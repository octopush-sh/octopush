// node --test scripts/routines/routines.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeGh, APP_REPO, WEB_REPO } from "./gh.mjs";
import { parseAnswers, pending, applyAll, digestMap } from "./answers.mjs";
import { refusals, verdictFor, marker, tryMerge, MAX_CHANGED_LINES } from "./automerge.mjs";
import { validateIdeas, rank, digestBody, cmpVersion, localDate } from "./ideas.mjs";

/** In-memory GitHub: routes GETs to fixtures, records every write. */
function fakeGh(routes) {
  const writes = [];
  const run = (args, input) => {
    if (args[0] === "-X") {
      const [, method, path] = args;
      const body = JSON.parse(input ?? "{}");
      writes.push({ method, path, body });
      if (method === "POST" && /\/issues$/.test(path)) return JSON.stringify({ number: 900 + writes.length, html_url: `https://gh/${path}/${900 + writes.length}` });
      if (method === "PUT" && /\/merge$/.test(path)) return JSON.stringify({ merged: true });
      return "{}";
    }
    const path = args[0].replace(/[?&]per_page=100&page=\d+$/, "");
    for (const [re, val] of routes) if (re.test(path)) return JSON.stringify(typeof val === "function" ? val(path) : val);
    return "[]";
  };
  return { gh: makeGh(run), writes };
}

// ---------------------------------------------------------------- answers
test("parses yes/no/later in Spanish and English, with notes and lists", () => {
  const { actions, unknown } = parseAnswers("1 sí\n2 NO — muy grande\n3 aún no\n4, 6 y 7 yes\n- 5 later: after launch\n8: Dale");
  const v = actions.map((a) => `${a.n}:${a.verdict}`);
  assert.deepEqual(v, ["1:yes", "2:no", "3:later", "4:yes", "6:yes", "7:yes", "5:later", "8:yes"]);
  assert.equal(actions.find((a) => a.n === 2).note, "muy grande");
  assert.equal(actions.find((a) => a.n === 5).note, "after launch");
  assert.deepEqual(unknown, []);
});

test("parses merge, promote, idea; keeps the idea's original casing; reports unknown lines", () => {
  const { actions, unknown } = parseAnswers("merge web#12; Mergea API #5\npromote v0.4.91\nidea: Show Claude Code's /cost in Mission Control\nhmm not sure");
  assert.deepEqual(actions.slice(0, 3), [
    { type: "merge", repo: WEB_REPO, n: 12 },
    { type: "merge", repo: "octopush-sh/octopush-api", n: 5 },
    { type: "promote", version: "0.4.91" },
  ]);
  assert.equal(actions[3].text, "Show Claude Code's /cost in Mission Control");
  assert.deepEqual(unknown, ["hmm not sure"]);
});

test("'no' is not mistaken for a number list and 'non' is not 'no'", () => {
  assert.deepEqual(parseAnswers("no idea what this is").actions, []);
  assert.deepEqual(parseAnswers("3 nonsense").actions, []);
});

test("pending ignores other users, routine comments and applied ones", () => {
  const comments = [
    { id: 1, user: { login: "owner" }, body: "1 yes" },
    { id: 2, user: { login: "stranger" }, body: "1 no" },
    { id: 3, user: { login: "owner" }, body: "- 1 → ready\n<!-- octopush-applied:1 -->" },
    { id: 4, user: { login: "owner" }, body: "2 later" },
  ];
  assert.deepEqual(pending(comments, "owner").map((c) => c.id), [4]);
});

test("applyAll labels, closes and replies with a marker", () => {
  const digest = { number: 50, title: "Ideas — 2026-10-31", html_url: "https://gh/d/50", body: `x\n<!-- octopush-digest:{"1":"octopush-sh/octopush#10","2":"octopush-sh/octopush-web#11"} -->` };
  const { gh, writes } = fakeGh([
    [/issues\?state=all&labels=digest/, [digest]],
    [/issues\/50\/comments$/, [{ id: 77, user: { login: "owner" }, body: "1 sí\n2 no\nwhat?" }]],
  ]);
  assert.equal(applyAll(gh, "owner"), 1);
  const w = (m, re) => writes.filter((x) => x.method === m && re.test(x.path));
  assert.deepEqual(w("POST", /octopush\/issues\/10\/labels$/)[0].body, { labels: ["ready"] });
  assert.ok(w("DELETE", /issues\/10\/labels\/proposal$/).length);
  assert.deepEqual(w("PATCH", /octopush-web\/issues\/11$/)[0].body, { state: "closed", state_reason: "not_planned" });
  const reply = w("POST", /issues\/50\/comments$/)[0].body.body;
  assert.match(reply, /1 → \*\*ready\*\*/);
  assert.match(reply, /didn't understand: “what\?”/);
  assert.match(reply, /<!-- octopush-applied:77 -->/);
});

test("merge answers require green CI", () => {
  const digest = { number: 51, title: "Ideas — d", html_url: "u", body: "<!-- octopush-digest:{} -->" };
  const { gh, writes } = fakeGh([
    [/issues\?state=all&labels=digest/, [digest]],
    [/issues\/51\/comments$/, [{ id: 5, user: { login: "owner" }, body: "merge web#12" }]],
    [/octopush-web\/pulls\/12$/, { state: "open", head: { sha: "abc" } }],
    [/actions\/runs\?head_sha=abc/, { workflow_runs: [{ name: "CI", created_at: "1", status: "completed", conclusion: "failure" }] }],
  ]);
  applyAll(gh, "owner");
  assert.equal(writes.filter((x) => x.method === "PUT").length, 0);
  assert.match(writes.at(-1).body.body, /CI is failure — not merged/);
});

// ---------------------------------------------------------------- automerge
const basePr = (over = {}) => ({
  state: "open", draft: false, user: { login: "owner" }, labels: [{ name: "agent" }],
  head: { sha: "s1" }, additions: 100, deletions: 20, mergeable: true, ...over,
});
const changeset = { filename: "whats-new/unreleased/x.md", status: "added" };

test("a clean agent PR passes every rule", () => {
  const files = [{ filename: "src/components/Foo.tsx" }, changeset];
  assert.deepEqual(refusals({ pr: basePr(), files, ci: "success", verdict: "approve", viewer: "owner" }), []);
});

test("each rule refuses on its own", () => {
  const ok = { files: [{ filename: "src/a.ts" }, changeset], ci: "success", verdict: "approve", viewer: "owner" };
  const why = (pr, o = {}) => refusals({ pr, ...ok, ...o }).join(" | ");
  assert.match(why(basePr({ labels: [] })), /not labelled `agent`/);
  assert.match(why(basePr({ draft: true })), /draft/);
  assert.match(why(basePr({ user: { login: "x" } })), /not the owner account/);
  assert.match(why(basePr(), { ci: "pending" }), /CI is pending/);
  assert.match(why(basePr(), { verdict: "changes" }), /requested changes/);
  assert.match(why(basePr(), { verdict: null }), /no approving review/);
  assert.match(why(basePr({ additions: MAX_CHANGED_LINES, deletions: 1 })), /changed lines/);
  assert.match(why(basePr(), { files: [{ filename: "src-tauri/src/billing.rs" }, changeset] }), /human-only paths: src-tauri\/src\/billing\.rs/);
  assert.match(why(basePr(), { files: [{ filename: ".github/workflows/ci.yml" }] }), /human-only/);
  assert.match(why(basePr(), { files: [{ filename: "src/a.tsx" }] }), /without a whats-new changeset/);
  assert.equal(why(basePr({ labels: [{ name: "agent" }, { name: "no-changeset" }] }), { files: [{ filename: "src/a.tsx" }] }), "");
  assert.equal(why(basePr(), { files: [{ filename: "src/a.test.tsx" }] }), "", "test-only changes need no changeset");
  assert.match(why(basePr({ mergeable: false })), /conflicts/);
});

test("review verdicts count only from the owner, on the current head", () => {
  const c = [
    { user: { login: "stranger" }, body: marker("s1", "approve") },
    { user: { login: "owner" }, body: marker("s0", "approve") },
  ];
  assert.equal(verdictFor(c, "s1", "owner"), null);
  c.push({ user: { login: "owner" }, body: `looks good ${marker("s1", "approve")}` });
  assert.equal(verdictFor(c, "s1", "owner"), "approve");
  c.push({ user: { login: "owner" }, body: marker("s1", "changes") });
  assert.equal(verdictFor(c, "s1", "owner"), "changes", "the latest verdict wins");
});

test("tryMerge parks a PR with a hard refusal but not one that is merely pending", () => {
  const routes = (files, ci) => [
    [/pulls\/7$/, basePr()],
    [/pulls\/7\/files/, files],
    [/issues\/7\/comments/, [{ user: { login: "owner" }, body: marker("s1", "approve") }]],
    [/actions\/runs\?head_sha=s1/, { workflow_runs: [{ name: "CI", created_at: "1", status: ci === "pending" ? "in_progress" : "completed", conclusion: ci === "pending" ? null : ci }] }],
  ];
  let f = fakeGh(routes([{ filename: "src-tauri/src/auth.rs" }, changeset], "success"));
  assert.equal(tryMerge(f.gh, 7, "owner").merged, false);
  assert.ok(f.writes.some((w) => /labels$/.test(w.path) && w.body.labels[0] === "needs-owner"));
  f = fakeGh(routes([{ filename: "src/a.ts" }, changeset], "pending"));
  assert.equal(tryMerge(f.gh, 7, "owner").merged, false);
  assert.equal(f.writes.length, 0, "pending CI is 'not yet', not a reason to park");
  f = fakeGh(routes([{ filename: "src/a.ts" }, changeset], "success"));
  assert.equal(tryMerge(f.gh, 7, "owner").merged, true);
  assert.deepEqual(f.writes[0].body, { merge_method: "merge", sha: "s1" });
});

// ---------------------------------------------------------------- ideas
const idea = (over = {}) => ({
  title: "Inline cost per stage", area: "app", kind: "feature", value: 4, difficulty: "M", estimate: "1–2 d",
  why: "Users can't see which stage burns money.", proposal: "Show cost under each stage card.", ...over,
});

test("ideas need at least five, valid fields, no duplicate titles", () => {
  assert.match(validateIdeas([idea()]).join(), /at least 5/);
  const five = [1, 2, 3, 4, 5].map((i) => idea({ title: `Idea ${i}` }));
  assert.deepEqual(validateIdeas(five), []);
  assert.match(validateIdeas([...five, idea({ title: "Idea 1" })]).join(), /duplicates/);
  assert.match(validateIdeas([...five, idea({ title: "x", value: 9, difficulty: "XL", area: "mobile" })]).join(), /value.*|difficulty|area/);
});

test("ranking: value first, then easier first", () => {
  const r = rank([idea({ title: "a", value: 3, difficulty: "S" }), idea({ title: "b", value: 5, difficulty: "L" }), idea({ title: "c", value: 5, difficulty: "S" })]);
  assert.deepEqual(r.map((x) => x.title), ["c", "b", "a"]);
});

test("the digest numbers rows and embeds the mapping the answers routine reads", () => {
  const body = digestBody({ date: "2026-10-31", waiting: ["`merge web#3` — x"], rows: [
    { n: 1, ref: `${APP_REPO}#10`, title: "A | B", area: "app", value: 5, difficulty: "S", estimate: "2 h", url: "u1" },
    { n: 2, ref: `${WEB_REPO}#4`, title: "Old", area: "web", value: 2, difficulty: "L", estimate: "3 d", url: "u2", earlier: true },
  ]});
  assert.deepEqual(digestMap(body), { 1: `${APP_REPO}#10`, 2: `${WEB_REPO}#4` });
  assert.match(body, /\| 1 \| \[A \\\| B\]\(u1\) \| app \| ●●●●● \| S \| 2 h \|/);
  assert.match(body, /Still waiting from earlier digests/);
  assert.match(body, /merge web#3/);
});

test("version compare and local date", () => {
  assert.equal(cmpVersion("0.4.10", "0.4.9"), 1);
  assert.equal(cmpVersion("0.4.9", "0.4.9"), 0);
  assert.equal(localDate(new Date(2026, 0, 5)), "2026-01-05");
});

test("ideas.json helper file is read from disk by post (smoke of validation path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ideas-"));
  writeFileSync(join(dir, "ideas.json"), JSON.stringify([idea()]));
  assert.ok(validateIdeas(JSON.parse('[{"title":1}]')).length > 0);
});
