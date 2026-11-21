import { describe, it, expect, vi } from "vitest";
import { refetchForWorkspace } from "./workspaceRefetch";

describe("refetchForWorkspace (#908)", () => {
  it("applies the answer while its workspace is still active", async () => {
    const apply = vi.fn();
    const applied = await refetchForWorkspace("a", async () => "status of a", () => "a", apply);
    expect(applied).toBe(true);
    expect(apply).toHaveBeenCalledWith("status of a");
  });

  it("drops the answer when the user switched workspace while it was read", async () => {
    let active: string | null = "a";
    let resolve!: (v: string) => void;
    const apply = vi.fn();
    const pending = refetchForWorkspace(
      "a",
      () => new Promise<string>((r) => (resolve = r)),
      () => active,
      apply,
    );
    active = "b";
    resolve("status of a");
    expect(await pending).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("drops it when no workspace is active any more", async () => {
    const apply = vi.fn();
    expect(await refetchForWorkspace("a", async () => 1, () => null, apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("lets a failed read reject without applying", async () => {
    const apply = vi.fn();
    await expect(
      refetchForWorkspace("a", () => Promise.reject(new Error("git")), () => "a", apply),
    ).rejects.toThrow("git");
    expect(apply).not.toHaveBeenCalled();
  });
});
