#!/usr/bin/env bash
# Re-record the Claude Code contract fixtures for the installed `claude` CLI.
#
#   scripts/record-claude-fixtures.sh [--force]
#
# Writes src-tauri/tests/fixtures/claude-code/<claude --version>/, scrubbed by
# scripts/scrub-claude-fixtures.py. Makes 5 tiny `claude -p` calls on
# claude-haiku-4-5 (3 billed, a few cents; 2 use a nonexistent model and fail
# before any tokens are spent), plus `--help` / `mcp` calls that cost nothing.
#
# Privacy: the only file read under ~/.claude is the transcript of the session
# this script itself creates (in a fresh temp dir). `claude mcp add` runs with
# HOME pointed at a throwaway directory, so your real MCP config is never
# touched or read. Raw output goes to a temp dir that is deleted on exit;
# nothing recorded is printed.
set -euo pipefail

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

REPO="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO/src-tauri/tests/fixtures/claude-code"
CLAUDE="$(command -v claude || true)"
[[ -n "$CLAUDE" ]] || { echo "claude CLI not found on PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

VERSION="$("$CLAUDE" --version | awk '{print $1}')"
OUT="$FIXTURES/$VERSION"
if [[ -e "$OUT" && $FORCE -eq 0 ]]; then
  echo "$OUT already exists — pass --force to overwrite" >&2
  exit 1
fi
PREV="$(ls -1 "$FIXTURES" | grep -v README | sort -V | grep -vx "$VERSION" | tail -n 1 || true)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CWD="$WORK/cwd"; RAW="$WORK/raw"; TMPHOME="$WORK/home"
mkdir -p "$CWD" "$RAW" "$TMPHOME"
CWD="$(cd "$CWD" && pwd -P)"   # Claude Code records the physical cwd (/private/var/… on macOS)
printf 'hello fixture\n' > "$CWD/note.txt"
MODEL=claude-haiku-4-5
BAD_MODEL=claude-nonexistent-model-0

run() { # <name> <args…> — stream-json to raw/<name>.jsonl, stderr kept private
  local name="$1"; shift
  (cd "$CWD" && "$CLAUDE" "$@" > "$RAW/$name.jsonl" 2> "$RAW/$name.err") || true
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

SJ=(--output-format stream-json --verbose)
run simple -p "Reply with exactly: ok" "${SJ[@]}" --model "$MODEL" --tools "" --max-turns 1
run tool   -p "Use the Read tool to read note.txt, then reply with exactly its contents." "${SJ[@]}" \
           --model "$MODEL" --tools Read --allowedTools Read --max-turns 3
SID="$(session_of "$RAW/tool.jsonl")"
[[ -n "$SID" ]] || { echo "tool-use run produced no session id — see the CLI's stderr by re-running by hand" >&2; exit 1; }
run resume -p "Now reply with exactly: resumed" "${SJ[@]}" --model "$MODEL" --resume "$SID" --tools "" --max-turns 1
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

# The transcript of the recorded session — the ONLY file read under ~/.claude.
MANGLED="$(printf '%s' "$CWD" | sed 's/[^A-Za-z0-9]/-/g')"
TRANSCRIPT="$HOME/.claude/projects/$MANGLED/$SID.jsonl"
if [[ -f "$TRANSCRIPT" ]]; then
  cp "$TRANSCRIPT" "$RAW/transcript.jsonl"
  printf '%s\n' "$SID" > "$RAW/transcript.sid"
  echo "recorded transcript"
else
  echo "WARNING: no transcript at ~/.claude/projects/$MANGLED/<session>.jsonl —" \
       "Claude Code's directory naming may have changed (transcripts.rs::project_dir_name)" >&2
fi

# CLI + `mcp add` contract, with a throwaway HOME.
(cd "$CWD" && "$CLAUDE" --help > "$RAW/cli-help.txt" 2>&1) || true
(cd "$CWD" && "$CLAUDE" mcp add --help > "$RAW/mcp-add-help.txt" 2>&1) || true
MCP_BIN="/Users/dev/Applications/Octopush.app/Contents/MacOS/octopush-mcp"
(cd "$CWD" && HOME="$TMPHOME" "$CLAUDE" mcp add octopush -s user -- "$MCP_BIN" > "$RAW/mcp-add.txt" 2>&1) || true
(cd "$CWD" && HOME="$TMPHOME" "$CLAUDE" mcp get octopush > "$RAW/mcp-get.txt" 2>&1) || true
python3 -I - "$TMPHOME/.claude.json" "$RAW/mcp-config.json" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    d = {}
json.dump({"mcpServers": d.get("mcpServers", {})}, open(sys.argv[2], "w"), indent=2)
PY
echo "recorded mcp add"

# Best effort: the interactive TUI's bytes (and a `/cost` summary, if the
# session can start). No model call is made.
python3 -I - "$CLAUDE" "$CWD" "$RAW/pty.ansi" <<'PY' || true
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
pump(10); os.write(fd, b"\r"); pump(4)
os.write(fd, b"/cost"); pump(1); os.write(fd, b"\r"); pump(4)
os.write(fd, b"/exit"); pump(1); os.write(fd, b"\r"); pump(5)
try:
    os.kill(pid, 9)
except OSError:
    pass
open(out, "wb").write(buf)
PY

rm -rf "$OUT"; mkdir -p "$OUT"
python3 -I "$REPO/scripts/scrub-claude-fixtures.py" "$RAW" "$OUT" "$CWD" "$TMPHOME"
printf '%s\n' "$VERSION" > "$OUT/VERSION"

# The PTY cost tail cannot always be captured; carry the previous one forward.
if [[ -n "$PREV" ]]; then
  for f in total-cost-tail.ansi total-cost-tail.txt; do
    [[ -f "$OUT/pty/$f" ]] || cp "$FIXTURES/$PREV/pty/$f" "$OUT/pty/$f" 2>/dev/null || true
  done
  [[ -f "$OUT/README.md" ]] || sed "s/$PREV/$VERSION/g" "$FIXTURES/$PREV/README.md" > "$OUT/README.md"
fi
if python3 -I -c 'import re,sys; t=open(sys.argv[1],errors="replace").read(); t=re.sub(r"\x1b\[[0-9;?>]*[GC]"," ",t); sys.exit(0 if "Total cost:" in t else 1)' "$OUT/pty/tui-render-sample.ansi" 2>/dev/null; then
  echo "NOTE: the TUI capture contains a real 'Total cost:' summary — consider replacing pty/total-cost-tail.* with it (and drop 'synthetic' from the README)."
fi

cat <<EOF

Fixtures written to src-tauri/tests/fixtures/claude-code/$VERSION/
Next:
  1. Review the diff by hand — scrubbing is automatic, but you own what gets committed:
       git diff --stat; grep -rn "\$HOME\|sk-ant\|@\|org_" src-tauri/tests/fixtures/claude-code/$VERSION
  2. Update the provenance table in $VERSION/README.md (real vs synthetic).
  3. Run the contract tests:  cd src-tauri && cargo test claude_code_contract
     A red test names the fixture and the field Claude Code changed.
EOF
