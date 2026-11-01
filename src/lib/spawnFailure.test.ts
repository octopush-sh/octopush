import { describe, it, expect } from "vitest";
import { describeSpawnFailure, spawnErrorDetail } from "./spawnFailure";

describe("spawnErrorDetail", () => {
  it("reads strings, Errors and IPC error objects", () => {
    expect(spawnErrorDetail("plain")).toBe("plain");
    expect(spawnErrorDetail(new Error("from js"))).toBe("from js");
    expect(spawnErrorDetail({ message: "from ipc" })).toBe("from ipc");
    expect(spawnErrorDetail({ code: 1 })).toBe('{"code":1}');
  });
});

describe("describeSpawnFailure", () => {
  it("names the likely cause in one sentence", () => {
    expect(describeSpawnFailure("Operation not permitted (os error 1)")).toMatch(/denied permission/);
    expect(describeSpawnFailure("No such file or directory (os error 2)")).toMatch(/couldn't be found/);
    expect(describeSpawnFailure("something else")).toBe(
      "The terminal couldn't start a shell for this workspace.",
    );
  });

  // Fixtures below are the exact strings `pty_client.rs` / `pty_daemon.rs` produce.
  it("describes an error the daemon reported by its actual cause, not as service down", () => {
    expect(describeSpawnFailure("daemon error: No such file or directory (os error 2)")).toMatch(
      /couldn't be found/,
    );
    expect(describeSpawnFailure("daemon error: Operation not permitted (os error 1)")).toMatch(
      /denied permission/,
    );
    expect(describeSpawnFailure("daemon error: unknown terminal")).toBe(
      "The terminal couldn't start a shell for this workspace.",
    );
  });

  it("says the service isn't responding only when it couldn't be reached", () => {
    for (const msg of [
      "daemon unavailable",
      "write to daemon: Broken pipe (os error 32)",
      "daemon response timeout",
      "daemon connection is broken",
      "connect to daemon: Connection refused (os error 61)",
      "reconnect to daemon: No such file or directory (os error 2)",
      "daemon error: daemon connection closed",
    ]) {
      expect(describeSpawnFailure(msg)).toBe("The background terminal service isn't responding.");
    }
  });

  it("says the service couldn't be started when the daemon binary is missing or won't launch", () => {
    for (const msg of [
      "octopush-pty-server binary not found next to executable or in $PATH",
      "PTY daemon failed to start within 2.5s",
      "failed to spawn daemon: Permission denied (os error 13)",
    ]) {
      expect(describeSpawnFailure(msg)).toBe("The background terminal service couldn't be started.");
    }
  });
});
