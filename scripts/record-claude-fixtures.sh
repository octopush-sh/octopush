#!/usr/bin/env bash
# Re-record the Claude Code contract fixtures for the installed `claude` CLI.
#
#   OCTOPUSH_FIXTURE_ANTHROPIC_KEY=sk-ant-… scripts/record-claude-fixtures.sh [--force]
#
# Writes src-tauri/tests/fixtures/claude-code/<claude --version>/.
#
# Isolation — what this script does and does not touch:
#   - It never reads or writes the real ~/.claude or ~/.claude.json. EVERY
#     `claude` invocation (the -p runs, `mcp add`/`mcp get`, `--help`, the TUI
#     capture) runs with HOME set to a fresh temp directory, CLAUDE_CONFIG_DIR
#     unset, and auth only through the API key in OCTOPUSH_FIXTURE_ANTHROPIC_KEY,
#     exported as ANTHROPIC_API_KEY for those child processes alone (any
#     ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_BASE_URL in your
#     shell is removed for them; set OCTOPUSH_FIXTURE_ANTHROPIC_BASE_URL to use a
#     gateway). The -p runs also pass --strict-mcp-config --setting-sources
#     project, so no user hooks, plugins or MCP servers load.
#   - The transcript is read from that temp HOME. The temp directory (HOME,
#     cwd, raw output) is deleted on exit, success or not.
#   - Without OCTOPUSH_FIXTURE_ANTHROPIC_KEY it exits 3 before doing anything.
#   - Out of scope: the macOS keychain is not touched by this script; whether
#     the CLI itself consults it when an API key is set is up to the CLI.
#
# Output is recorded and scrubbed into the temp dir first; the scrubber's leak
# check must pass before anything is moved into the repo, and an existing
# version directory is replaced (with --force) only after that. Five tiny
# `claude -p` calls on claude-haiku-4-5 (3 billed, a few cents; 2 use a
# nonexistent model and fail before any tokens). Nothing recorded is printed.
set -euo pipefail

if [[ -z "${OCTOPUSH_FIXTURE_ANTHROPIC_KEY:-}" ]]; then
  echo "recording skipped: set OCTOPUSH_FIXTURE_ANTHROPIC_KEY (an Anthropic API key used only for these recordings)" >&2
  exit 3
fi

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/src-tauri/tests/fixtures/claude-code"
CLAUDE="$(command -v claude || true)"
[[ -n "$CLAUDE" ]] || { echo "claude CLI not found on PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
WORK="$(cd "$WORK" && pwd -P)"   # Claude Code records the physical path (/private/var/… on macOS)
CWD="$WORK/cwd"; RAW="$WORK/raw"; TMPHOME="$WORK/home"; STAGE="$WORK/out"
mkdir -p "$CWD" "$RAW" "$TMPHOME"

# Every `claude` call goes through here: temp HOME, explicit API key only.
cc() {
  env -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_BASE_URL -u CLAUDE_CONFIG_DIR \
    HOME="$TMPHOME" ANTHROPIC_API_KEY="$OCTOPUSH_FIXTURE_ANTHROPIC_KEY" \
    ${OCTOPUSH_FIXTURE_ANTHROPIC_BASE_URL:+ANTHROPIC_BASE_URL="$OCTOPUSH_FIXTURE_ANTHROPIC_BASE_URL"} \
    "$@"
}

VERSION="$(cc "$CLAUDE" --version | awk '{print $1}')"
OUT="$FIXTURES/$VERSION"
if [[ -e "$OUT" && $FORCE -eq 0 ]]; then
  echo "$OUT already exists — pass --force to replace it" >&2
  exit 1
fi
# The newest other recording (numeric version order), for carrying forward.
PREV="$(ls -1 "$FIXTURES" | grep -vx "$VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)"

printf 'hello fixture\n' > "$CWD/note.txt"
MODEL=claude-haiku-4-5
BAD_MODEL=claude-nonexistent-model-0
SJ=(--output-format stream-json --verbose --strict-mcp-config --setting-sources project)

run() { # <name> <args…> — stream-json to raw/<name>.jsonl, stderr kept private
  local name="$1"; shift
  (cd "$CWD" && cc "$CLAUDE" "$@" > "$RAW/$name.jsonl" 2> "$RAW/$name.err") || true
  echo "recorded $name ($(wc -l < "$RAW/$name.jsonl" | tr -d ' ') events)"
}
session_of() { # <raw jsonl> — the session id of its result event
  python3 -I - "$1" <<'PY'
import json, sys
for line in open(sys.argv[1], errors="replace"):
    try:
        v = json.loads(line)
    except ValueError:
        continue
    if v.get("type") == "result" and v.get("session_id"):
        print(v["session_id"]); break
PY
}

succeeded() { # <raw jsonl> — its result event exists and is not an error
  python3 -I - "$1" <<'PY'
import json, sys
for line in open(sys.argv[1], errors="replace"):
    try:
        v = json.loads(line)
    except ValueError:
        continue
    if v.get("type") == "result":
        sys.exit(1 if v.get("is_error") else 0)
sys.exit(1)
PY
}

run simple -p "Reply with exactly: ok" "${SJ[@]}" --model "$MODEL" --tools "" --max-turns 1
succeeded "$RAW/simple.jsonl" || {
  echo "the first run failed (invalid OCTOPUSH_FIXTURE_ANTHROPIC_KEY? see the result text by re-running by hand) — nothing was written" >&2
  exit 1
}
run tool   -p "Use the Read tool to read note.txt, then reply with exactly its contents." "${SJ[@]}" \
           --model "$MODEL" --tools Read --allowedTools Read --max-turns 3
SID="$(session_of "$RAW/tool.jsonl")"
if [[ -z "$SID" ]] || ! succeeded "$RAW/tool.jsonl"; then
  echo "the tool-use run failed — nothing was written" >&2; exit 1
fi
run resume -p "Now reply with exactly: resumed" "${SJ[@]}" --model "$MODEL" --resume "$SID" --tools "" --max-turns 1
succeeded "$RAW/resume.jsonl" || { echo "the --resume run failed — nothing was written" >&2; exit 1; }
run error  -p "Reply with exactly: ok" "${SJ[@]}" --model "$BAD_MODEL" --tools "" --max-turns 1

# Skill + agent definitions: Claude Code's init event lists what it loaded.
mkdir -p "$CWD/.claude/skills/fixture-skill" "$CWD/.claude/agents"
cat > "$CWD/.claude/skills/fixture-skill/SKILL.md" <<'EOF'
---
name: fixture-skill
description: Contract-test skill. Reply with the word fixture.
allowed-tools: Read, Grep
---
When this skill is used, reply with exactly: fixture

---

- The rule above and this list item belong to the body.
EOF
cat > "$CWD/.claude/agents/fixture-reviewer.md" <<'EOF'
---
name: fixture-reviewer
description: Contract-test reviewer agent. Reads files and reports.
tools: Read, Grep, Glob, mcp__octopush
model: haiku
effort: low
max-turns: 4
---
You are a reviewer used only by Octopush's contract tests. Read the file you are given and report one sentence.
EOF
run defs -p "Reply with exactly: ok" "${SJ[@]}" --model "$BAD_MODEL" --tools "" --max-turns 1

# The recorded session's transcript — from the temp HOME, never ~/.claude.
MANGLED="$(printf '%s' "$CWD" | sed 's/[^A-Za-z0-9]/-/g')"
TRANSCRIPT="$TMPHOME/.claude/projects/$MANGLED/$SID.jsonl"
if [[ -f "$TRANSCRIPT" ]]; then
  cp "$TRANSCRIPT" "$RAW/transcript.jsonl"
  printf '%s\n' "$SID" > "$RAW/transcript.sid"
  echo "recorded transcript"
else
  echo "WARNING: no transcript at <temp HOME>/.claude/projects/<mangled cwd>/<session>.jsonl —" \
       "Claude Code's directory naming may have changed (transcripts.rs::project_dir_name)" >&2
fi

# CLI flags + the `mcp add` registration. MCP_BIN and the argv below must stay
# identical to mcp_setup::mcp_add_args — the contract test
# `the_recorder_registers_with_the_same_argv` checks this file for it.
(cd "$CWD" && cc "$CLAUDE" --help > "$RAW/cli-help.txt" 2>&1) || true
(cd "$CWD" && cc "$CLAUDE" mcp add --help > "$RAW/mcp-add-help.txt" 2>&1) || true
MCP_BIN="/Users/dev/Applications/Octopush.app/Contents/MacOS/octopush-mcp"
(cd "$CWD" && cc "$CLAUDE" mcp add octopush -s user -- "$MCP_BIN" > "$RAW/mcp-add.txt" 2>&1) || true
(cd "$CWD" && cc "$CLAUDE" mcp get octopush > "$RAW/mcp-get.txt" 2>&1) || true
python3 -I - "$TMPHOME/.claude.json" "$RAW/mcp-config.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    d = {}
json.dump({"mcpServers": d.get("mcpServers", {})}, open(sys.argv[2], "w"), indent=2)
PY
echo "recorded mcp add"

# Best effort: the interactive TUI's bytes and a `/cost` summary, if the
# session gets that far with a fresh HOME. No model call is made. The
# scrubber keeps only the banner line and the `Total cost:` region.
cc python3 -I - "$CLAUDE" "$CWD" "$RAW/pty.ansi" <<'PY' || true
import os, pty, select, sys, time
claude, cwd, out = sys.argv[1:4]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execv(claude, [claude, "--model", "claude-haiku-4-5"])
buf = b""
def pump(secs):
    global buf
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                buf += os.read(fd, 65536)
            except OSError:
                return
pump(10); os.write(fd, b"\r"); pump(4)   # first-run prompts take the default
os.write(fd, b"/cost"); pump(1); os.write(fd, b"\r"); pump(4)
os.write(fd, b"/exit"); pump(1); os.write(fd, b"\r"); pump(5)
try:
    os.kill(pid, 9)
except OSError:
    pass
open(out, "wb").write(buf)
PY

# Scrub into the temp stage; the leak check fails closed (set -e) before
# anything reaches the repo.
# Carry the cost tail forward from this version's existing directory when
# re-recording it, else from the newest other version.
CARRY=()
if [[ -d "$OUT" ]]; then CARRY=(--carry "$OUT"); PREV="$VERSION (previous recording)"
elif [[ -n "$PREV" && -d "$FIXTURES/$PREV" ]]; then CARRY=(--carry "$FIXTURES/$PREV"); fi
python3 -I "$REPO/scripts/scrub-claude-fixtures.py" "$RAW" "$STAGE" "$CWD" "$TMPHOME" \
  --version "$VERSION" --date "$(date -u +%Y-%m-%d)" ${CARRY[@]+"${CARRY[@]}"}
for f in pty/total-cost-tail.ansi pty/total-cost-tail.txt pty/tui-render-sample.ansi; do
  [[ -f "$STAGE/$f" ]] || echo "WARNING: $f was neither captured nor carried forward — the PTY contract tests will fail for $VERSION" >&2
done

# Validated: move into place (the old directory goes only now).
mkdir -p "$FIXTURES"
if [[ -e "$OUT" ]]; then mv "$OUT" "$WORK/replaced"; fi
mv "$STAGE" "$OUT"

cat <<EOF

Fixtures written to src-tauri/tests/fixtures/claude-code/$VERSION/
Next:
  1. Review the diff by hand (scrubbing is automatic, but you own what is committed):
       git status src-tauri/tests/fixtures; git diff --stat
  2. Check $VERSION/README.md: its provenance table says which files are real
     and which were carried forward from ${PREV:-an earlier version}.
  3. Run the contract tests:  cd src-tauri && cargo test claude_code_contract
     A red test names the fixture and the field Claude Code changed.
EOF
