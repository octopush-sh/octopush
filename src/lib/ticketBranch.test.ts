import { describe, expect, it } from "vitest";
import { ticketBranch } from "./ticketBranch";

describe("ticketBranch", () => {
  it("prefers a local branch to a remote one", () => {
    expect(ticketBranch(["main", "feat/ENG-42-return-path"], ["origin/ENG-42-other"], "ENG-42")).toBe("feat/ENG-42-return-path");
  });

  it("falls back to the first remote branch, origin-qualified", () => {
    expect(ticketBranch(["main"], ["origin/dev", "origin/fix/ENG-42", "origin/ENG-42-b"], "ENG-42")).toBe("origin/fix/ENG-42");
  });

  it("matches the key exactly: ENG-4 never matches ENG-42, nor ENG-42 ENG-421", () => {
    expect(ticketBranch(["feat/ENG-42-x"], [], "ENG-4")).toBeNull();
    expect(ticketBranch(["feat/ENG-421-x"], ["origin/ENG-4200"], "ENG-42")).toBeNull();
    expect(ticketBranch(["feat/ENG-4-x", "feat/ENG-42-x"], [], "ENG-42")).toBe("feat/ENG-42-x");
  });

  it("is null with no match", () => {
    expect(ticketBranch(["main", "release/1.0"], ["origin/dev"], "ENG-42")).toBeNull();
    expect(ticketBranch([], [], "ENG-42")).toBeNull();
  });

  it("never picks an earlier test's throwaway branch", () => {
    expect(ticketBranch(["test/ENG-42", "ENG-42-login"], [], "ENG-42")).toBe("ENG-42-login");
    expect(ticketBranch(["test/ENG-42"], ["origin/test/ENG-42"], "ENG-42")).toBeNull();
  });
});
