// node --test scripts/routines/frozen-node.test.mjs
//
// The builders (nightly-build, web-build, epiku-build) run agent-written code
// as octo-sandbox: their Node and Claude Code CLI come from frozen-node.sh, and
// every step after the agent is guarded. These tests read the workflows as
// text and run the parts of frozen-node.sh that need no sudo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wf = (f) => readFileSync(new URL(`../../.github/workflows/${f}`, import.meta.url), "utf8");
const live = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
/** The steps of a workflow's only job, in order: their name and their whole text (comments dropped). */
const steps = (text) => live(text).split("\n      - ").slice(1).map((s) => ({ name: /^name: (.*)$/m.exec(s)?.[1] ?? s.split("\n")[0], text: s }));
const at = (list, prefix) => { const i = list.findIndex((s) => s.name.startsWith(prefix)); assert.ok(i >= 0, prefix); return i; };
const GUARD = /\/usr\/bin\/bash "\$RUNNER_TEMP\/routines\/frozen-node\.sh" guard "\$RUNNER_TEMP\/routines"/;
const SHELL = /\n        shell: \/usr\/bin\/bash --noprofile --norc -e \{0\}\n/;

const BUILDERS = [
  // file, the step that first brings in what the agent works on, the moved .git, the checkout
  { file: "nightly-build.yml", untrusted: "Context and brief", gitDir: "repo.git", checkout: "$GITHUB_WORKSPACE" },
  { file: "web-build.yml", untrusted: "Check out octopush-web", gitDir: "web.git", checkout: "$GITHUB_WORKSPACE/web" },
  { file: "epiku-build.yml", untrusted: "Fetch epiku", gitDir: "epiku.git", checkout: "$GITHUB_WORKSPACE/epiku" },
];

for (const b of BUILDERS) {
  test(`${b.file}: Node and the Claude Code CLI are frozen before the agent's work arrives, and nothing else installs them`, () => {
    const text = wf(b.file);
    const list = steps(text);
    const freeze = at(list, "Node 22 and the Claude Code CLI, root-owned and read-only");
    const s = list[freeze].text;
    assert.match(s, /\n        if: steps\.pick\.outputs\.kind != ''\n/, "only when there is a job: an empty queue stays cheap");
    assert.match(s, /run: OCTO_NODE_GLOBALS="@anthropic-ai\/claude-code@\$CLAUDE_CODE_VERSION" bash "\$RUNNER_TEMP\/routines\/frozen-node\.sh" freeze\n?$/, "from the trusted copy, the exact CLI version");
    assert.doesNotMatch(s, /secrets\.|TOKEN|github\.token|outputs\.token/, "the CLI's install script runs with nothing to take");
    assert.ok(at(list, "Trusted copy of the routines") < freeze, "the script comes from main's copy");
    assert.ok(freeze < at(list, b.untrusted), "before the agent's branch or repo is in the workspace");
    assert.ok(freeze < at(list, "Install and sandbox"));
    assert.doesNotMatch(live(text), /npm (install|i) (--global|-g)\b/, "the CLI is never installed into the shared tool cache");
    assert.match(live(text), /\n  CLAUDE_CODE_VERSION: "\d+\.\d+\.\d+"\n/);
    // The sandbox's setup bakes the frozen Node into octo-check: refuse to go on with any other.
    const install = list[at(list, "Install and sandbox")].text;
    assert.match(install, /for c in node npm npx claude; do\n\s+\[ "\$\(command -v "\$c"\)" = "\/opt\/octo-node\/bin\/\$c" \] \|\| \{ echo "::error::\$c is not the frozen copy"; exit 1; \}\n\s+done\n/);
    assert.ok(install.indexOf("/opt/octo-node/bin/$c") < install.indexOf("agent-sandbox-setup.sh"));
  });

  test(`${b.file}: every step after the agent is guarded, runs no code of the checkout and is not found through PATH`, () => {
    const text = wf(b.file);
    const list = steps(text);
    const agent = at(list, "Build (Claude agent");
    const after = list.slice(agent + 1);
    assert.ok(after.length >= 4);
    // The first one stops the sandbox and is not resolved through PATH; the
    // first guard comes before any action (a token) and any node.
    assert.match(after[0].name, /^Stop the sandbox and freeze the checkout/);
    assert.match(after[0].text, /\n        if: always\(\) && steps\.pick\.outputs\.kind != ''\n/);
    const firstGuard = after.findIndex((s) => /frozen-node\.sh" guard/.test(s.text));
    assert.ok(firstGuard >= 0 && firstGuard <= 1, "the sandbox is proved gone right after it is stopped");
    assert.match(after[firstGuard].text, /\n        id: sandbox-gone\n/, "the guarded step is the one publishing depends on");
    for (const [i, s] of after.entries()) {
      if (/\n        uses: /.test(`\n${s.text}`)) {
        assert.ok(i > firstGuard, `${s.name}: an action runs only after the guard`);
        continue;
      }
      assert.match(s.text, SHELL, `${s.name}: its shell is /usr/bin/bash, not whatever PATH finds`);
      const run = s.text.slice(s.text.indexOf("        run: "));
      const cmds = run.replace(/^        run: \|?\n?/, "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (i === 0 || i === firstGuard) {
        assert.ok(/^(job_path="\$PATH"|PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin)$/.test(cmds[0]), `${s.name}: PATH is reset before anything runs`);
      } else {
        const first = cmds[0] === "set -euo pipefail" ? cmds[1] : cmds[0];
        assert.match(first, GUARD, `${s.name}: the guard runs before anything else`);
      }
      assert.doesNotMatch(run, /\bnpx?\b|\bsource\b|^\s*\. /m, `${s.name}: no npm, npx or sourced file after the agent`);
      assert.doesNotMatch(run.replace(/\$RUNNER_TEMP\/routines\//g, ""), /\bscripts\//, `${s.name}: only the trusted copy of the routines runs`);
      assert.doesNotMatch(s.text, /\n          (GIT_[A-Z_]+|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_[A-Z_]+): /, `${s.name}: no variable that makes git, node, bash or the loader run other code`);
    }
    // Publishing needs the guarded step to have passed, and checks again itself, with the moved .git.
    const pub = after.find((s) => s.name === "Publish");
    assert.match(pub.text, /\n        if: steps\.pick\.outputs\.kind != '' && !cancelled\(\) && steps\.sandbox-gone\.outcome == 'success'\n/);
    assert.match(pub.text, new RegExp(`frozen-node\\.sh" guard "\\$RUNNER_TEMP/routines" "\\$RUNNER_TEMP/${b.gitDir.replace(".", "\\.")}"\\n`));
    assert.match(after[firstGuard].text, new RegExp(`frozen-node\\.sh" guard "\\$RUNNER_TEMP/routines" "\\$RUNNER_TEMP/${b.gitDir.replace(".", "\\.")}"\\n`));
    // The last step checks once more before the actions' post steps run.
    const last = after[after.length - 1];
    assert.equal(last.name, "Nothing the post steps run has changed");
    assert.match(last.text, /\n        if: always\(\) && steps\.pick\.outputs\.kind != ''\n/);
    assert.match(last.text, GUARD);
  });

  test(`${b.file}: a .git the sandbox made in the checkout is removed whatever fails, and stops publishing`, () => {
    const list = steps(wf(b.file));
    const after = list.slice(at(list, "Build (Claude agent") + 1);
    const co = b.checkout.replace(/[$/]/g, (c) => `\\${c}`);
    const remove = new RegExp(`if \\[ -d "\\$RUNNER_TEMP/${b.gitDir.replace(".", "\\.")}" \\] && \\{ \\[ -e "${co}/\\.git" \\] \\|\\| \\[ -L "${co}/\\.git" \\]; \\}; then\\n\\s+sudo rm -rf "${co}/\\.git"; `);
    assert.match(after[0].text, remove, "only once the real one was moved out, in the always-run stop step");
    assert.ok(after[0].text.indexOf("pkill -KILL -u octo-sandbox") < after[0].text.search(remove), "after the sandbox is killed");
    const gone = after.find((s) => /\n        id: sandbox-gone\n/.test(s.text));
    assert.match(gone.text, /echo "::error::[^"]*had a \.git of the sandbox's \(removed\): not publishing"; exit 1/);
  });

  test(`${b.file}: permissions and action pins are unchanged by the frozen Node`, () => {
    const text = live(wf(b.file));
    const perms = {
      "nightly-build.yml": "\npermissions:\n  contents: write\n  pull-requests: write\n  issues: write\n  actions: write\n\n",
      "web-build.yml": "\npermissions:\n  contents: read\n  issues: write\n\n",
      "epiku-build.yml": "\npermissions:\n  contents: read\n\n",
    }[b.file];
    assert.ok(text.replace(/[ \t]+#[^\n]*$/gm, "").includes(perms), "the workflow's permissions");
    assert.equal((text.match(/\n\s*permissions:/g) ?? []).length, 1, "no job widens them");
    const pins = b.file === "epiku-build.yml"
      ? { "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0", "actions/create-github-app-token": "f418cff399f7aef4c2f0ad47e25ca7a6abbdd6fc # v3.4.0" }
      : { "actions/checkout": "v7", "actions/setup-node": "v7", "actions/create-github-app-token": "v3" };
    for (const [, action, ref] of text.matchAll(/uses: (\S+)@(.*)/g)) assert.equal(ref, pins[action], `${action} pinned like the rest of the file`);
  });
}

test("epiku-build: the guard's findings are counted, never named (the workflow runs it quiet)", () => {
  assert.match(live(wf("epiku-build.yml")), /\n  OCTOPUSH_QUIET_ERRORS: "1"/);
  const src = readFileSync(new URL("./frozen-node.sh", import.meta.url), "utf8");
  assert.match(src, /QUIET="\$\{OCTOPUSH_QUIET_ERRORS:-\}"/);
  assert.match(src, /show\(\) \{ if \[\[ "\$QUIET" == 1 \]\]; then echo "\$\(grep -c \. <<<"\$1"\) path\(s\), not named in this log"/);
  assert.match(src, /\[\[ "\$QUIET" == 1 \]\] \|\| echo "closing \$f to other users"/);
});

const script = new URL("./frozen-node.sh", import.meta.url).pathname;
const run = (args, env) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("frozen-node.sh: Actions only, known commands only", () => {
  const temp = mkdtempSync(join(tmpdir(), "frozen-"));
  for (const cmd of ["freeze", "verify", "guard"]) {
    assert.equal(run([cmd], {}).status, 64, `${cmd} outside Actions`);
    assert.equal(run([cmd], { GITHUB_ACTIONS: "true" }).status, 64, `${cmd} without RUNNER_TEMP`);
  }
  assert.equal(run(["thaw"], { GITHUB_ACTIONS: "true", RUNNER_TEMP: temp }).status, 64);
  assert.equal(run([], { GITHUB_ACTIONS: "true", RUNNER_TEMP: temp }).status, 64);
});

test("frozen-node.sh freeze: global packages only at exact versions, refused before anything is touched", () => {
  const temp = mkdtempSync(join(tmpdir(), "frozen-"));
  for (const bad of ["claude", "claude@latest", "@anthropic-ai/claude-code@^2.1.0", "x@1.2.3;rm -rf /", "../x@1.0.0", "@a/b/c@1.0.0", "X@1.0.0", "a@1.2.3 b@next"]) {
    const r = run(["freeze"], { GITHUB_ACTIONS: "true", RUNNER_TEMP: temp, OCTO_NODE_GLOBALS: bad });
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /::error::frozen-node: OCTO_NODE_GLOBALS takes packages at exact versions/, bad);
  }
});

test("frozen-node.sh guard: a job that never created the sandbox user passes without checking anything", (t) => {
  if (spawnSync("id", ["-u", "octo-sandbox"]).status === 0) return t.skip("this machine has an octo-sandbox user");
  const r = run(["guard", "/nonexistent"], { GITHUB_ACTIONS: "true", RUNNER_TEMP: mkdtempSync(join(tmpdir(), "frozen-")) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no octo-sandbox user in this job: nothing untrusted has run/);
});

test("frozen-node.sh: what verify refuses (the checks themselves, read from the script)", () => {
  const src = readFileSync(new URL("./frozen-node.sh", import.meta.url), "utf8");
  // The frozen tree, PATH and LD_LIBRARY_PATH directories, the runner, the actions' code, ~/.config, the checkout's .git, extra trees.
  assert.match(src, /\[\[ "\$\(digest\)" == "\$\(cat "\$DIGEST"\)" \]\] \|\| die "\$NODE changed"/);
  assert.match(src, /left="\$\(findings "\$JOB_PATH:\$\{LD_LIBRARY_PATH:-\}"; gitdirs; variables\)"/);
  // Hooks and command-running configuration of every git directory among the trees.
  assert.match(src, /find "\$t\/hooks" -mindepth 1 ! -type d ! -name '\*\.sample' -print/);
  assert.match(src, /core\\\.\(hookspath\|fsmonitor\|sshcommand\|gitproxy\|askpass\)\|\(filter\|diff\|merge\)\\\.\.\+\\\.\(clean\|smudge\|process\|textconv\|command\|driver\)/);
  // Variables that make bash, node, git or the loader run other code.
  assert.match(src, /for v in BASH_ENV ENV NODE_OPTIONS NODE_PATH LD_PRELOAD LD_AUDIT; do/);
  assert.match(src, /GIT_TERMINAL_PROMPT\|GIT_AUTHOR_NAME\|GIT_AUTHOR_EMAIL\|GIT_COMMITTER_NAME\|GIT_COMMITTER_EMAIL\) ;;\n\s+GIT_\*\) echo "environment: \$v" ;;/);
  // guard: the sandbox's crontab and processes go first, proved gone.
  const guard = src.slice(src.indexOf("\n  guard)\n"));
  assert.ok(guard.indexOf("crontab -r -u") < guard.indexOf("pkill -KILL -u") && guard.indexOf("pkill -KILL -u") < guard.indexOf("die \"$SANDBOX_USER processes survived the kill\"") && guard.indexOf("survived the kill") < guard.indexOf("check"));
  // freeze: the packages are installed by the runner before the tree is closed, in place, with an empty environment.
  const freeze = src.slice(src.indexOf("\n  freeze)\n"), src.indexOf("\n  verify)\n"));
  assert.ok(freeze.indexOf("npm\" install --global --prefix \"$NODE\"") < freeze.indexOf("sudo chown -R root:root \"$NODE\""));
  assert.match(freeze, /\(cd \/ && env -i PATH="\$NODE\/bin:\/usr\/bin:\/bin" HOME="\$HOME"/);
  assert.ok(freeze.indexOf("sudo chmod -R a+rX,go-w \"$NODE\"") < freeze.indexOf("digest > \"$DIGEST\""));
});
