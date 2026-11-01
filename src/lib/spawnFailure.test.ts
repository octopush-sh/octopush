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
    expect(describeSpawnFailure("Daemon error: connection refused")).toMatch(/isn't responding/);
    expect(describeSpawnFailure("No such file or directory (os error 2)")).toMatch(/couldn't be found/);
    expect(describeSpawnFailure("something else")).toBe(
      "The terminal couldn't start a shell for this workspace.",
    );
  });
});
