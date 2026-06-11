import { describe, it, expect } from "vitest";
import { getExtension } from "./getExtension";

describe("getExtension", () => {
  it("returns the lowercased extension after the final dot", () => {
    expect(getExtension("main.RS")).toBe("rs");
    expect(getExtension("App.test.tsx")).toBe("tsx");
    expect(getExtension("archive.tar.gz")).toBe("gz");
  });

  it("works on full paths, not just basenames", () => {
    expect(getExtension("src/lib/ipc.ts")).toBe("ts");
    expect(getExtension("/abs/path/to/Cargo.toml")).toBe("toml");
  });

  it("returns the empty string when there is no extension", () => {
    expect(getExtension("README")).toBe("");
    expect(getExtension("")).toBe("");
  });

  it("treats dotfiles as their own extension (existing table behavior)", () => {
    // All three tables historically resolved ".gitignore" to ext "gitignore"
    // (fileIcons maps it via its CONFIG set).
    expect(getExtension(".gitignore")).toBe("gitignore");
  });

  it("returns the empty string for a trailing dot", () => {
    expect(getExtension("weird.")).toBe("");
  });
});
