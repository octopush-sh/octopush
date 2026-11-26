import { describe, it, expect } from "vitest";
import { exitCodeFromResult, toolVerdict, verdictCounts } from "./toolVerdict";
import type { ToolExecution } from "../stores/chatStore";

const run = (result: string, extra: Partial<ToolExecution> = {}): ToolExecution => ({
  toolName: "run_command",
  toolInput: { command: "cargo test" },
  result,
  ...extra,
});

const APPROVAL_DENIAL =
  "Command not run — the user declined to approve it (flagged: rewrites published history). " +
  "Ask the user how to proceed or try a safer alternative.";

describe("toolVerdict — rows the engine stamped", () => {
  it("a pass is unmarked", () => {
    expect(toolVerdict(run("test result: ok", { ok: true, outcome: "ok", exitCode: 0 }))).toEqual({
      kind: "ok",
      meta: "",
      title: "",
    });
  });

  it("a non-zero exit reads its code, in the row and in words", () => {
    expect(toolVerdict(run("error[E0308]: mismatched types\n(exit code 101)", { ok: false, outcome: "failed", exitCode: 101 }))).toEqual({
      kind: "failed",
      meta: "exit 101",
      title: "Exited with code 101",
    });
  });

  it("a denial is its own verdict, with the reason it gave", () => {
    expect(toolVerdict(run(APPROVAL_DENIAL, { ok: false, outcome: "denied" }))).toEqual({
      kind: "denied",
      meta: "denied",
      title: "Denied, not run: the user declined to approve it (flagged: rewrites published history)",
    });
  });

  it("the secret guard's denial reads as a denial too", () => {
    const v = toolVerdict(
      run(
        "Command not run — the secret guard found 1 GitHub token in src/a.ts:3 in what it would commit or push, " +
          "and the user declined. Take it out of the change or ask the user how to proceed; do not retry the same command.",
        { ok: false, outcome: "denied" },
      ),
    );
    expect(v.kind).toBe("denied");
    expect(v.title).toContain("the secret guard found 1 GitHub token in src/a.ts:3");
  });

  it("a timeout says so, not the shell's -1", () => {
    const v = toolVerdict(
      run(
        "Compiling…\n(command was still running after 600s and was interrupted — the output above may be incomplete)\n(exit code -1)",
        { ok: false, outcome: "failed" },
      ),
    );
    expect(v).toEqual({ kind: "failed", meta: "timed out", title: "Timed out and was stopped" });
    expect(toolVerdict(run("Command timed out after 30s and was killed.", { ok: false, outcome: "failed" })).meta).toBe("timed out");
  });

  it("a stop mid-command reads as stopped", () => {
    expect(toolVerdict(run("Command stopped by the director.", { ok: false, outcome: "failed" })).meta).toBe("stopped");
  });

  it("what the engine stamped wins over the text", () => {
    // A stamped exit code, whatever the output says.
    expect(
      toolVerdict(run("Command timed out after 5s and was killed.\n(exit code 2)", { ok: false, outcome: "failed", exitCode: 2 })),
    ).toEqual({ kind: "failed", meta: "exit 2", title: "Exited with code 2" });
    // The engine stopped it: stopped, not SIGINT's 130.
    expect(
      toolVerdict(run("ready on :3000\n^C\n(exit code 130)", { ok: false, outcome: "failed", exitCode: 130, reason: "stopped" })),
    ).toEqual({ kind: "failed", meta: "stopped", title: "Stopped before it finished" });
  });

  it("an MCP call to a server turned off in the conversation reads as denied", () => {
    const v = toolVerdict({
      toolName: "mcp__docs__search",
      toolInput: { q: "x" },
      result: 'docs is turned off in this conversation, so its tools are unavailable here. The user can turn it back on in the Companion\'s "can use" row.',
      ok: false,
      outcome: "denied",
    });
    expect(v).toEqual({
      kind: "denied",
      meta: "denied",
      title: "Denied, not run: docs is turned off in this conversation, so its tools are unavailable here",
    });
  });

  it("a failure with no exit code gives the first line of what went wrong", () => {
    const v = toolVerdict({
      toolName: "read_file",
      toolInput: { path: "missing.txt" },
      result: "\nError reading file: No such file or directory (os error 2)\nmore",
      ok: false,
      outcome: "failed",
    });
    expect(v).toEqual({
      kind: "failed",
      meta: "failed",
      title: "Failed: Error reading file: No such file or directory (os error 2)",
    });
  });

  it("a file read that only quotes the engine's words stays what it was", () => {
    const quoting: ToolExecution = {
      toolName: "read_file",
      toolInput: { path: "notes.md" },
      result: "Command timed out after 5s\n(exit code 2)",
      ok: true,
      outcome: "ok",
    };
    expect(toolVerdict(quoting).kind).toBe("ok");
    expect(toolVerdict({ ...quoting, ok: false, outcome: "failed" }).meta).toBe("failed");
  });
});

describe("toolVerdict — older rows, read from their result", () => {
  it("a trailing (exit code N) is a failure", () => {
    expect(toolVerdict(run("FAIL src/a.test.ts\n(exit code 1)"))).toEqual({
      kind: "failed",
      meta: "exit 1",
      title: "Exited with code 1",
    });
    // The 127 note follows the exit line; the code is still read.
    expect(toolVerdict(run("bash: gh: command not found\n(exit code 127)\n`gh` wasn't found.")).meta).toBe("exit 127");
  });

  it("an (exit code 0) or no marker at all is a pass", () => {
    expect(toolVerdict(run("(exit code 0)")).kind).toBe("ok");
    expect(toolVerdict(run("test result: ok. 9 passed")).kind).toBe("ok");
  });

  it("the denial text is a denial", () => {
    expect(toolVerdict(run(APPROVAL_DENIAL)).kind).toBe("denied");
  });

  it("the shared shell's timeout ends in (exit code -1): a failure that reads as timed out", () => {
    const v = toolVerdict(run("Compiling…\n(command was still running after 600s and was interrupted — the output above may be incomplete)\n(exit code -1)"));
    expect(v).toEqual({ kind: "failed", meta: "timed out", title: "Timed out and was stopped" });
  });

  it("output that only mentions an exit line or the timeout sentence in the middle stays unmarked", () => {
    expect(toolVerdict(run("(exit code 1)\nretrying…\ntest result: ok")).kind).toBe("ok");
    expect(
      toolVerdict(run("note: (command was still running after 600s and was interrupted — retried)\nall green")).kind,
    ).toBe("ok");
    expect(toolVerdict(run("Command timed out after 5s and was killed. (quoted by a test fixture)")).kind).toBe("ok");
  });

  it("other tools are never guessed at", () => {
    expect(toolVerdict({ toolName: "read_file", toolInput: { path: "a" }, result: "(exit code 1)" }).kind).toBe("ok");
    expect(toolVerdict({ toolName: "read_file", toolInput: { path: "a" }, result: APPROVAL_DENIAL }).kind).toBe("ok");
  });
});

describe("exitCodeFromResult", () => {
  it("reads only a trailing exit line (the 127 note may follow it), never one in the middle", () => {
    expect(exitCodeFromResult("exit code 3 in a sentence")).toBeNull();
    expect(exitCodeFromResult("(exit code 2)\nretry\n(exit code 1)")).toBe(1);
    expect(exitCodeFromResult("(exit code -1)")).toBe(-1);
    expect(exitCodeFromResult("(exit code 1)\nthen it passed")).toBeNull();
    expect(exitCodeFromResult("bash: gh: command not found\n(exit code 127)\n`gh` wasn't found (the command ran with your login shell's PATH).")).toBe(127);
    expect(exitCodeFromResult("out\n(exit code 1)\n")).toBe(1);
  });
});

describe("verdictCounts", () => {
  it("counts failures and denials apart; passes count as neither", () => {
    expect(
      verdictCounts([
        run("ok", { ok: true, outcome: "ok" }),
        run("(exit code 1)", { ok: false, outcome: "failed", exitCode: 1 }),
        run(APPROVAL_DENIAL, { ok: false, outcome: "denied" }),
        run("(exit code 2)"),
      ]),
    ).toEqual({ failed: 2, denied: 1 });
  });
});
