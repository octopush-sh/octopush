#!/usr/bin/env python3
"""Scrub raw Claude Code recordings into contract-test fixtures.

Usage:
  scrub-claude-fixtures.py <raw-dir> <out-dir> <recording-cwd> [<temp-home>]
                           [--version V --date YYYY-MM-DD [--carry <prev-version-dir>]]

With --version, also writes VERSION and a README.md whose provenance table
says, per file, whether it is real (recorded now) or carried forward.

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
  - `entrypoint` (which names the recording host's client) becomes `cli`;
  - from a TUI capture only the `Welcome to Claude Code` banner line (its
    cursor-move encoding) and, when present, the `Total cost:` summary region
    are kept — never the rest of the screen (account, org, network errors).
A final leak check over the whole output fails the run (exit 1) if anything
path-, key-, email- or identity-shaped survives (user name, host name, git
identity, an account name from the temp HOME's config). Write into a scratch
directory and move it into place only after this exits 0. Nothing is printed
except file names and the leak-check verdict (never the matched text).
"""
import getpass
import json
import os
import re
import shutil
import socket
import subprocess
import sys

FAKE_CWD = "/Users/dev/project"
FAKE_HOME = "/Users/dev"
TEXT_CAP = 200

args = sys.argv[1:]
opts = {}
for flag in ("--version", "--date", "--carry"):
    if flag in args:
        i = args.index(flag)
        opts[flag] = args[i + 1]
        del args[i:i + 2]
raw_dir, out_dir, rec_cwd = args[0], args[1], args[2]
temp_home = args[3] if len(args) > 3 else None
provenance = {}  # fixture path → "real" / "carried forward …"
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


def transcript_line_neutral(v):
    r = transcript_line(v)
    if "entrypoint" in r:
        r["entrypoint"] = "cli"  # names the recording host's client — not a contract
    return r


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
    provenance[os.path.relpath(dst, out_dir)] = "real"
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
    provenance[os.path.relpath(dst, out_dir)] = "real"
    print("wrote", os.path.relpath(dst, out_dir))


def screen_text(s):
    """Python twin of token_engine::screen_text (cursor moves → one space)."""
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        i += 1
        if c != "\x1b":
            out.append(c)
            continue
        if i >= n:
            break
        k = s[i]
        i += 1
        if k == "[":
            while i < n:
                f = s[i]
                i += 1
                if "\x40" <= f <= "\x7e":
                    if f in "GC":
                        out.append(" ")
                    break
        elif k in "]PX^_":
            while i < n:
                f = s[i]
                i += 1
                if f == "\x07":
                    break
                if f == "\x1b":
                    i += 1
                    break
        elif k in "()*+":
            i += 1
    return "".join(out)


def tui_capture(src):
    """Keep only the banner line and the `Total cost:` region of a TUI capture.
    Returns whether a `Total cost:` summary was captured."""
    raw = open(src, "rb").read().decode("utf-8", errors="replace")
    raw = ANSI_OSC.sub("", raw)
    lines = raw.split("\n")
    screens = [screen_text(l) for l in lines]
    banner = [l for l, sc in zip(lines, screens)
              if re.fullmatch(r"\s*Welcome to Claude Code(\s+v[0-9.]+)?\s*", sc)]
    if banner:
        os.makedirs(o("pty"), exist_ok=True)
        with open(o("pty", "tui-render-sample.ansi"), "w", encoding="utf-8", newline="") as f:
            f.write(scrub_str(banner[0].rstrip("\r")) + "\r\n")
        provenance["pty/tui-render-sample.ansi"] = "real (banner line only)"
        print("wrote pty/tui-render-sample.ansi")
    start = next((i for i, sc in enumerate(screens) if "Total cost:" in sc), None)
    if start is None:
        return False
    end = start + 1
    while end < len(lines) and end - start < 12 and screens[end].strip():
        end += 1
    region = [scrub_str(l.rstrip("\r")) for l in lines[start:end]]
    os.makedirs(o("pty"), exist_ok=True)
    for name, body in (("total-cost-tail.ansi", "\r\n".join(region) + "\r\n"),
                       ("total-cost-tail.txt", "\n".join(screen_text(l).rstrip() for l in region) + "\n")):
        with open(o("pty", name), "w", encoding="utf-8", newline="") as f:
            f.write(body)
        provenance["pty/" + name] = "real (`/cost` summary region only)"
        print("wrote pty/" + name)
    return True


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
    jsonl(p("transcript.jsonl"), o("transcript", fake_session(sid) + ".jsonl"), transcript_line_neutral)

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
    provenance["mcp/mcp-config.json"] = "real (only the mcpServers entry)"
    print("wrote mcp/mcp-config.json")

captured_cost = os.path.exists(p("pty.ansi")) and tui_capture(p("pty.ansi"))
carry = opts.get("--carry")
if not captured_cost and carry:
    prev = os.path.basename(os.path.normpath(carry))
    for name in ("total-cost-tail.ansi", "total-cost-tail.txt"):
        if os.path.exists(os.path.join(carry, "pty", name)):
            os.makedirs(o("pty"), exist_ok=True)
            shutil.copyfile(os.path.join(carry, "pty", name), o("pty", name))
            provenance["pty/" + name] = ("carried forward from %s, NOT re-captured for this version "
                                         "(synthetic unless %s's README says real)" % (prev, prev))
            print("carried pty/%s from %s" % (name, prev))

for src, dst in [(".claude/skills/fixture-skill/SKILL.md", "definitions/skills/fixture-skill/SKILL.md"),
                 (".claude/agents/fixture-reviewer.md", "definitions/agents/fixture-reviewer.md")]:
    if os.path.exists(os.path.join(rec_cwd, src)):
        os.makedirs(os.path.dirname(o(dst)), exist_ok=True)
        shutil.copyfile(os.path.join(rec_cwd, src), o(dst))
        provenance[dst] = "hand-written by the recorder; loaded by the real CLI (see init-with-definitions.jsonl)"
        print("wrote", dst)

if "--version" in opts:
    version, date = opts["--version"], opts.get("--date", "unknown date")
    with open(o("VERSION"), "w") as f:
        f.write(version + "\n")
    rows = "\n".join("| `%s` | %s |" % (k, v) for k, v in sorted(provenance.items()))
    with open(o("README.md"), "w") as f:
        f.write("""# Claude Code contract fixtures — v%s

Recorded %s with Claude Code %s by `scripts/record-claude-fixtures.sh` and
scrubbed by `scripts/scrub-claude-fixtures.py` (how to re-record and the
scrubbing rules: those scripts' headers and the 2.1.314 README).

## Provenance

| File | Source |
|---|---|
%s
""" % (version, date, version, rows))
    print("wrote VERSION, README.md")

# ── Leak check ────────────────────────────────────────────────────────────
# Matched values are never printed — only which kind of needle hit where.
home = os.path.expanduser("~")
needles = [("path", "/home/"), ("path", "/root"), ("path", "/tmp/"), ("path", "/private/"),
           ("path", "/var/folders"), ("path", home + "/"), ("key", "sk-ant"), ("org id", "org_"),
           ("email", "@")]
if temp_home:
    needles.append(("temp HOME", temp_home))


def identity(kind, value):
    # Too short or too generic to mean anything (a git name of "Claude" would
    # match every fixture) — skipped rather than drowning the check in noise.
    value = (value or "").strip()
    if len(value) >= 4 and value.lower() not in {"claude", "user", "admin", "localhost", "root"}:
        needles.append((kind, value))


try:
    identity("user name", getpass.getuser())
except Exception:
    pass
identity("host name", socket.gethostname().split(".")[0])
for key in ("user.name", "user.email"):
    try:
        identity("git " + key, subprocess.run(["git", "config", "--get", key], capture_output=True,
                                              text=True, timeout=5).stdout)
    except Exception:
        pass
if temp_home:
    try:
        acct = json.load(open(os.path.join(temp_home, ".claude.json"))).get("oauthAccount") or {}
        for k in ("displayName", "emailAddress", "organizationName", "organizationUuid", "accountUuid"):
            if isinstance(acct.get(k), str):
                identity("account " + k, acct[k])
    except (OSError, ValueError, AttributeError):
        pass
OTHER_USERS = re.compile(r"/Users/(?!dev(?:/|\b))[A-Za-z0-9._-]+")

bad = []
for root, _, files in os.walk(out_dir):
    for fname in files:
        path = os.path.join(root, fname)
        rel = os.path.relpath(path, out_dir)
        text = open(path, encoding="utf-8", errors="replace").read()
        for kind, n in needles:
            if n in text:
                bad.append("%s: contains a %s" % (rel, kind))
        if OTHER_USERS.search(text):
            bad.append("%s: contains a /Users/<name> path other than /Users/dev" % rel)
if bad:
    print("LEAK CHECK FAILED (nothing should be moved into place); fix the scrubber:")
    for b in sorted(set(bad)):
        print("  " + b)
    sys.exit(1)
print("leak check: clean")
