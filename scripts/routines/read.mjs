#!/usr/bin/env node
// Trusted reading for agents (prompt-injection guard). The repos are public:
// anyone can comment on an issue or PR. Agents read issues and PRs only through
// this script, which shows text written by the owner, builder or reviewer and
// omits everyone else's.
//
//   read.mjs issue <n> [owner/repo]
//   read.mjs pr <n> [owner/repo]       (body + trusted comments; use `gh pr diff <n>` for the code)
//
// octopush-web is read with the cycle's App token (OCTOPUSH_WEB_TOKEN), and
// there the App's bot is the builder and reviewer (identity.mjs idsForRepo).
import { ghForRepo, APP_REPO, WEB_REPO, labelsOf, reportFatal } from "./gh.mjs";
import { loadIdentities, requireIdentities, sameLogin, idsForRepo } from "./identity.mjs";

export function render({ item, comments, ids, kind, repo = APP_REPO }) {
  const trusted = (login) => [ids.owner, ids.builder, ids.reviewer].some((t) => sameLogin(t, login));
  const role = (login) => (sameLogin(login, ids.owner) ? "owner" : sameLogin(login, ids.reviewer) ? "reviewer" : sameLogin(login, ids.builder) ? "builder" : "outsider");
  const out = [`# ${kind} ${repo === APP_REPO ? "" : repo}#${item.number}: ${item.title}`, `state: ${item.state} · author: ${role(item.user?.login)} · labels: ${labelsOf(item).join(", ") || "none"}`, ""];
  // An outsider can edit their text at any time — even after the owner labelled
  // it `ready` — so it is never shown; the owner restates the work in a comment.
  if (trusted(item.user?.login)) out.push(item.body?.trim() || "(no description)");
  else out.push("(description by an outside contributor omitted — the owner's comments below describe the work)");
  let omitted = 0;
  for (const c of comments) {
    if (!trusted(c.user?.login)) { omitted++; continue; }
    out.push("", `--- ${role(c.user.login)} · ${c.created_at}`, c.body?.trim() ?? "");
  }
  if (omitted) out.push("", `(${omitted} comment${omitted === 1 ? "" : "s"} from outside contributors omitted)`);
  return out.join("\n");
}

async function main() {
  const [kind, n, repo = APP_REPO] = process.argv.slice(2);
  if (!["issue", "pr"].includes(kind) || !/^\d+$/.test(n ?? "")) { console.error("usage: read.mjs issue|pr <n> [owner/repo]"); return 64; }
  if (![APP_REPO, WEB_REPO].includes(repo)) { console.error(`read.mjs: ${repo} is not a cycle repo`); return 64; }
  const ids = idsForRepo(requireIdentities(loadIdentities()), repo);
  const gh = ghForRepo(repo);
  const item = gh.get(`repos/${repo}/${kind === "pr" ? "pulls" : "issues"}/${n}`);
  const comments = gh.list(`repos/${repo}/issues/${n}/comments`);
  console.log(render({ item, comments, ids, kind, repo }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { reportFatal("read", e); process.exit(2); });
}
