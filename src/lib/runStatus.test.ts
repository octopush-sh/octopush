import { describe, it, expect } from "vitest";
import { isTransientHalt } from "./runStatus";

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
