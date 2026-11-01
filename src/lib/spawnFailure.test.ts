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

  // Fixtures below are the exact strings that reach JS over IPC: every error on
  // this path is an `AppError::Other`, serialised as `other: <message>`.
  it("describes an error the daemon reported by its actual cause, not as service down", () => {
    expect(
      describeSpawnFailure("other: daemon error: spawn: No such file or directory (os error 2)"),
    ).toMatch(/couldn't be found/);
    expect(
      describeSpawnFailure("other: daemon error: spawn: Operation not permitted (os error 1)"),
    ).toMatch(/denied permission/);
    expect(describeSpawnFailure("other: daemon error: spawn: Broken pipe (os error 32)")).toBe(
      "The terminal couldn't start a shell for this workspace.",
    );
    expect(describeSpawnFailure("other: daemon error: terminal t-1 already exists")).toBe(
      "The terminal couldn't start a shell for this workspace.",
    );
  });

  it("says the service isn't responding only when it couldn't be reached", () => {
    for (const msg of [
      "other: daemon unavailable",
      "other: write to daemon: Broken pipe (os error 32)",
      "other: daemon response timeout",
      "other: daemon connection is broken",
      "other: daemon error: daemon connection closed",
    ]) {
      expect(describeSpawnFailure(msg)).toBe("The background terminal service isn't responding.");
    }
  });

  it("never says the service couldn't be started: that case only reaches JS as unreachable", () => {
    expect(describeSpawnFailure("other: daemon unavailable")).not.toMatch(/couldn't be started/);
  });
});
