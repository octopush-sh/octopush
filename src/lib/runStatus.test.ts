import { describe, it, expect } from "vitest";
import { fleetCounts, isTransientHalt, needsYou, settledCounts } from "./runStatus";
import type { RunStatus } from "./ipc";
import { isPlanWaiting } from "./planWait";
import fixtures from "./needsYou.fixtures.json";

/** A plan park with (`true`) or without (`false`) a scheduled resume. */
function planWaitFor(scheduled: boolean) {
  return { window: "five_hour", resetsAt: 1_793_551_200, resumeAt: scheduled ? 1_793_551_290 : null, resumeCount: 0, otherHold: false };
}

describe("needsYou parity with the Dock badge (Rust fleet_status)", () => {
  it("answers each status as the shared fixture says", () => {
    for (const c of fixtures.statuses) {
      expect(needsYou({ status: c.status as RunStatus }), c.status).toBe(c.needsYou);
    }
  });

  it("answers each plan-waiting case as the shared fixture says", () => {
    for (const c of fixtures.planWaiting) {
      const run = { status: c.status as RunStatus, planWait: planWaitFor(c.planWaiting) };
      expect(needsYou(run), `${c.status} ${c.planWaiting}`).toBe(c.needsYou);
    }
  });

  it("is calm only when the plan-limited stages are all that wait, as the shared fixture says", () => {
    for (const c of fixtures.planWait) {
      const run = {
        status: c.status as RunStatus,
        planWait: { window: "five_hour", resetsAt: 1_793_551_200, resumeAt: c.resumeAt, resumeCount: 0, otherHold: c.otherHold },
      };
      const label = `${c.status} resumeAt=${c.resumeAt} otherHold=${c.otherHold}`;
      expect(isPlanWaiting(run), label).toBe(c.planWaiting);
      expect(needsYou(run), label).toBe(c.needsYou);
    }
  });

  it("splits each fleet as the shared fixture says", () => {
    for (const f of fixtures.fleets) {
      const waiting = (f as { planWaiting?: boolean[] }).planWaiting;
      const counts = fleetCounts(
        f.statuses.map((status, i) => ({ status: status as RunStatus, planWait: planWaitFor(waiting?.[i] ?? false) })),
      );
      expect(counts, f.statuses.join(",")).toEqual({ needsYou: f.needsYou, inFlight: f.inFlight });
    }
  });
});

describe("needsYou", () => {
  it("a paused run needs the director — the engine's one 'human must act' run status", () => {
    // `paused` covers every waiting reason at run level: gate, halted stage,
    // budget park, director pause (the stage detail says which).
    expect(needsYou({ status: "paused" })).toBe(true);
  });

  it("every other run status does not", () => {
    for (const status of ["running", "completed", "aborted", "failed"] as const) {
      expect(needsYou({ status }), status).toBe(false);
    }
  });
});

describe("isTransientHalt", () => {
  it("flags rate-limit / overload / server / network faults as transient", () => {
    const transient = [
      "Anthropic API error 429 Too Many Requests: rate_limit_error",
      "Anthropic API error 529: overloaded_error",
      "OpenAI-compat API error 503 Service Unavailable",
      "Anthropic API error 500: internal_server_error",
      "Anthropic API error 502 Bad Gateway",
      "Anthropic request failed: connection reset by peer",
      "request timed out after 60s",
      "dns error: failed to lookup host",
      // Startup recovery stamp for stages orphaned by a crash/quit.
      "interrupted — Octopush closed while this stage was in flight; the work on disk is preserved, resume the stage to continue",
    ];
    for (const e of transient) {
      expect(isTransientHalt(e), e).toBe(true);
    }
  });

  it("does NOT flag standing faults or non-API halts as transient", () => {
    const fatal = [
      null,
      "",
      "agentic loop hit 25 iterations without finishing — review the work journal",
      "stopped by the director — review the work journal, then accept, re-run, or abort",
      "Anthropic API error 401: authentication_error",
      "Anthropic API error 400: invalid_request_error",
      "unknown substrate 'foo'",
      "workspace has no worktree_path",
    ];
    for (const e of fatal) {
      expect(isTransientHalt(e), String(e)).toBe(false);
    }
  });

  it("never flags a hook-deferred tool halt, whatever its tool name or stderr tail says", () => {
    const deferred = [
      "A hook paused mcp__cloudflare-dns__create_record before it ran. Resume once it may run, or re-run the stage.\n(terminal_reason: tool_deferred)",
      "The resumed session was waiting to run echo (MCP server srv), which isn't available anymore. Reconnect it and resume, or re-run the stage fresh.\n(terminal_reason: tool_deferred_unavailable)\n— stderr —\nrequest timed out; connection refused",
    ];
    for (const e of deferred) {
      expect(isTransientHalt(e), e).toBe(false);
    }
  });

  it("matches the network patterns on word boundaries only", () => {
    for (const e of ["tool mcp__cloudflare-dns__create_record crashed", "wrote dnsmasq.conf", "subrequest failedover"]) {
      expect(isTransientHalt(e), e).toBe(false);
    }
  });

  it("does not false-positive on unrelated numbers in prose", () => {
    // A bare line/column, byte, or token count must not read as an HTTP status —
    // the code is only transient inside our "… API error <code> …" framing.
    const notTransient = [
      "edited 12 files, 4200 insertions",
      "plan has 5000 steps",
      "read 503 bytes from the file",
      "wrote 500 lines",
      "took 502 ms",
      "line 429 column 3 of src/foo.ts",
      "iteration 500 of 1000",
      "context window: 12,500 tokens",
      "TypeError at line 529",
    ];
    for (const e of notTransient) {
      expect(isTransientHalt(e), e).toBe(false);
    }
  });
});

describe("settledCounts", () => {
  it("counts only completed settled runs as done; aborted and failed are ended (#845)", () => {
    const runs = [
      { id: "a", status: "completed" as RunStatus },
      { id: "b", status: "aborted" as RunStatus },
      { id: "c", status: "failed" as RunStatus },
      { id: "d", status: "completed" as RunStatus }, // not settled this session
    ];
    expect(settledCounts(runs, { a: 1, b: 2, c: 3 })).toEqual({ done: 1, ended: 2 });
  });
});
