#!/usr/bin/env python3
"""Scrub raw Claude Code recordings into contract-test fixtures.

Usage:
  scrub-claude-fixtures.py <raw-dir> <out-dir> <recording-cwd> [<temp-home>]

Reads the raw files `scripts/record-claude-fixtures.sh` produces and writes
the fixture tree `src-tauri/tests/fixtures/claude-code/<version>/` expects.

Scrubbing is a WHITELIST, not a blacklist: every JSON line is rebuilt from
the fields Octopush's parsers read (plus a few structural ones), so a field
Claude Code adds tomorrow — which might carry a prompt, an account id or a
path — never reaches the repo by default. Then:
  - the recording cwd (and the temp HOME) become /Users/dev/project (/Users/dev);
  - session ids, uuids, msg_/req_/toolu_ ids become stable fake ids;
  - text beyond the tiny test strings is truncated;
  - `stream_event` lines (partial-message deltas, only emitted when partial
    messages are enabled — never in Octopush's invocation) are dropped.
A final leak check fails the run if anything path-, key- or email-shaped
survives. Nothing is printed except file names and the leak-check verdict.
"""
import json
import os
import re
import shutil
import sys

FAKE_CWD = "/Users/dev/project"
FAKE_HOME = "/Users/dev"
TEXT_CAP = 200

raw_dir, out_dir, rec_cwd = sys.argv[1], sys.argv[2], sys.argv[3]
temp_home = sys.argv[4] if len(sys.argv) > 4 else None
real_cwd = os.path.realpath(rec_cwd)

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
PREFIXED_RE = re.compile(r"\b(msg|req|toolu)_[A-Za-z0-9_]+")
maps = {"session": {}, "uuid": {}, "msg": {}, "req": {}, "toolu": {}}


def fake_session(sid):
    m = maps["session"]
    if sid not in m:
        m[sid] = "aaaaaaaa-0000-4000-8000-%012d" % (len(m) + 1)
    return m[sid]


def scrub_str(s):
    for real in sorted({rec_cwd, real_cwd}, key=len, reverse=True):
        s = s.replace(real, FAKE_CWD)
        s = s.replace(re.sub(r"[^A-Za-z0-9]", "-", real), re.sub(r"[^A-Za-z0-9]", "-", FAKE_CWD))
    if temp_home:
        s = s.replace(os.path.realpath(temp_home), FAKE_HOME).replace(temp_home, FAKE_HOME)

    def uuid_sub(m):
        u = m.group(0)
        if u in maps["session"] or u.startswith("aaaaaaaa-0000-4000-8000-"):
            return maps["session"].get(u, u)
        if u.startswith("00000000-0000-4000-8000-"):
            return u
        um = maps["uuid"]
        if u not in um:
            um[u] = "00000000-0000-4000-8000-%012d" % (len(um) + 1)
        return um[u]

    def pref_sub(m):
        kind, whole = m.group(1), m.group(0)
        if "_fixture_" in whole:
            return whole
        km = maps[kind]
        if whole not in km:
            km[whole] = "%s_fixture_%04d" % (kind, len(km) + 1)
        return km[whole]

    s = UUID_RE.sub(uuid_sub, s)
    return PREFIXED_RE.sub(pref_sub, s)


def deep(v):
    if isinstance(v, str):
        return scrub_str(v)
    if isinstance(v, list):
        return [deep(x) for x in v]
    if isinstance(v, dict):
        return {scrub_str(k): deep(x) for k, x in v.items()}
    return v


def pick(d, keys):
    return {k: d[k] for k in keys if isinstance(d, dict) and k in d}


def cap(s):
    return s if len(s) <= TEXT_CAP else s[:TEXT_CAP] + "…"


USAGE_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens",
              "cache_creation_input_tokens", "service_tier"]


def usage(u):
    return pick(u or {}, USAGE_KEYS)


def content_blocks(blocks):
    if isinstance(blocks, str):
        return cap(blocks)
    out = []
    for b in blocks or []:
        t = b.get("type")
        if t == "text":
            out.append({"type": "text", "text": cap(b.get("text", ""))})
        elif t == "thinking":
            out.append({"type": "thinking", "thinking": "", "signature": ""})
        elif t == "tool_use":
            out.append({"type": "tool_use", "id": b.get("id"), "name": b.get("name"),
                        "input": b.get("input", {})})
        elif t == "tool_result":
            c = b.get("content")
            if isinstance(c, list):
                c = [{"type": "text", "text": cap(x.get("text", ""))} for x in c if isinstance(x, dict)]
            elif isinstance(c, str):
                c = cap(c)
            r = {"type": "tool_result", "tool_use_id": b.get("tool_use_id"), "content": c}
            if "is_error" in b:
                r["is_error"] = b["is_error"]
            out.append(r)
        else:
            out.append({"type": t})
    return out


def message(m):
    r = pick(m, ["id", "type", "role", "model", "stop_reason"])
    if "content" in m:
        r["content"] = content_blocks(m["content"])
    if "usage" in m:
        r["usage"] = usage(m["usage"])
    return r


def stream_line(v):
    t = v.get("type")
    if t == "stream_event":
        return None
    sid = v.get("session_id")
    if sid:
        fake_session(sid)
    if t == "system" and v.get("subtype") == "init":
        r = pick(v, ["type", "subtype", "session_id", "uuid", "cwd", "model",
                     "permissionMode", "claude_code_version", "tools", "output_style"])
        for k in ("agents", "skills"):
            if k in v:
                r[k] = [x for x in v[k] if isinstance(x, str) and x.startswith("fixture-")]
        # MCP tools come from the recording machine's own config, not the CLI.
        r["tools"] = [x for x in v.get("tools", []) if not str(x).startswith("mcp__")]
        return r
    if t == "assistant":
        r = pick(v, ["type", "parent_tool_use_id", "session_id", "uuid", "timestamp",
                     "request_id", "error", "is_api_error_message"])
        r["message"] = message(v.get("message", {}))
        return r
    if t == "user":
        r = pick(v, ["type", "parent_tool_use_id", "session_id", "uuid", "timestamp"])
        m = v.get("message", {})
        r["message"] = {"role": m.get("role"), "content": content_blocks(m.get("content"))}
        return r
    if t == "result":
        r = pick(v, ["type", "subtype", "is_error", "num_turns", "session_id", "uuid",
                     "total_cost_usd", "duration_ms", "duration_api_ms", "stop_reason",
                     "terminal_reason", "api_error_status"])
        r["result"] = cap(v.get("result", ""))
        r["usage"] = usage(v.get("usage"))
        mu = v.get("modelUsage") or {}
        r["modelUsage"] = {k: {kk: vv for kk, vv in x.items() if isinstance(vv, (int, float))}
                           for k, x in mu.items() if isinstance(x, dict)}
        return r
    return pick(v, ["type", "subtype", "session_id", "uuid"])


def transcript_line(v):
    t = v.get("type")
    sid = v.get("sessionId")
    if sid:
        fake_session(sid)
    base = ["type", "uuid", "parentUuid", "sessionId", "timestamp", "cwd",
            "isSidechain", "version", "userType", "entrypoint"]
    if t == "assistant":
        r = pick(v, base + ["requestId", "isApiErrorMessage", "error", "apiErrorStatus"])
        r["message"] = message(v.get("message", {}))
        return r
    if t == "user":
        r = pick(v, base)
        m = v.get("message", {})
        r["message"] = {"role": m.get("role"), "content": content_blocks(m.get("content"))}
        return r
    return pick(v, ["type", "sessionId", "timestamp"])


def jsonl(src, dst, fn):
    out = []
    with open(src, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                v = json.loads(line)
            except ValueError:
                continue
            r = fn(v)
            if r is not None:
                out.append(r)
    # Session ids are collected first so uuid mapping never claims them.
    out = [deep(r) for r in out]
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("wrote", os.path.relpath(dst, out_dir))


ANSI_OSC = re.compile(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)")


def text_file(src, dst, ansi=False):
    with open(src, "rb") as f:
        s = f.read().decode("utf-8", errors="replace")
    if ansi:
        s = ANSI_OSC.sub("", s)
    s = scrub_str(s)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8", newline="") as f:
        f.write(s)
    print("wrote", os.path.relpath(dst, out_dir))


def p(*a):
    return os.path.join(raw_dir, *a)


def o(*a):
    return os.path.join(out_dir, *a)


# Session ids first (stable numbering: the first recorded run is …001).
for name in ["simple", "tool", "resume", "error", "defs"]:
    if os.path.exists(p(name + ".jsonl")):
        for line in open(p(name + ".jsonl"), encoding="utf-8", errors="replace"):
            try:
                sid = json.loads(line).get("session_id")
            except ValueError:
                continue
            if sid:
                fake_session(sid)

streams = {"simple": "simple.jsonl", "tool": "tool-use.jsonl", "resume": "resume.jsonl",
           "error": "error-unknown-model.jsonl", "defs": "init-with-definitions.jsonl"}
for name, dst in streams.items():
    if os.path.exists(p(name + ".jsonl")):
        fn = stream_line
        if name == "defs":
            # Only the init event matters (it lists the agents/skills Claude Code loaded).
            def fn(v):
                return stream_line(v) if v.get("subtype") == "init" else None
        jsonl(p(name + ".jsonl"), o("stream-json", dst), fn)

if os.path.exists(p("transcript.jsonl")):
    sid = open(p("transcript.sid")).read().strip() if os.path.exists(p("transcript.sid")) else None
    if sid is None:
        for line in open(p("transcript.jsonl"), encoding="utf-8", errors="replace"):
            try:
                sid = json.loads(line).get("sessionId")
            except ValueError:
                continue
            if sid:
                break
    jsonl(p("transcript.jsonl"), o("transcript", fake_session(sid) + ".jsonl"), transcript_line)

for src, dst in [("cli-help.txt", "cli-help.txt"), ("mcp-add-help.txt", "mcp/mcp-add-help.txt"), ("mcp-add.txt", "mcp/mcp-add.txt"),
                 ("mcp-get.txt", "mcp/mcp-get.txt")]:
    if os.path.exists(p(src)):
        text_file(p(src), o(dst))
if os.path.exists(p("mcp-config.json")):
    cfg = json.load(open(p("mcp-config.json")))
    os.makedirs(o("mcp"), exist_ok=True)
    with open(o("mcp", "mcp-config.json"), "w") as f:
        json.dump(deep({"mcpServers": cfg.get("mcpServers", {})}), f, indent=2)
        f.write("\n")
    print("wrote mcp/mcp-config.json")

if os.path.exists(p("pty.ansi")):
    text_file(p("pty.ansi"), o("pty", "tui-render-sample.ansi"), ansi=True)

for src, dst in [(".claude/skills/fixture-skill/SKILL.md", "definitions/skills/fixture-skill/SKILL.md"),
                 (".claude/agents/fixture-reviewer.md", "definitions/agents/fixture-reviewer.md")]:
    if os.path.exists(os.path.join(rec_cwd, src)):
        os.makedirs(os.path.dirname(o(dst)), exist_ok=True)
        shutil.copyfile(os.path.join(rec_cwd, src), o(dst))
        print("wrote", dst)

# ── Leak check ────────────────────────────────────────────────────────────
home = os.path.expanduser("~")
needles = ["/home/", "/root", "/tmp/", "/private/", "/var/folders", "sk-ant", "org_",
           "@", home + "/"]
if temp_home:
    needles.append(temp_home)
bad = []
for root, _, files in os.walk(out_dir):
    for fname in files:
        if fname == "README.md":
            continue
        path = os.path.join(root, fname)
        text = open(path, encoding="utf-8", errors="replace").read()
        for n in needles:
            if n and n in text:
                bad.append("%s: contains %r" % (os.path.relpath(path, out_dir), n))
if bad:
    print("LEAK CHECK FAILED — fix the scrubber before committing:")
    for b in bad:
        print("  " + b)
    sys.exit(1)
print("leak check: clean")
