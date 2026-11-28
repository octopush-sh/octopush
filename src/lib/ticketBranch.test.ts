import { describe, expect, it } from "vitest";
import { ticketBranch } from "./ticketBranch";

describe("ticketBranch", () => {
  it("prefers a local branch to a remote one", () => {
    expect(ticketBranch(["main", "feat/ENG-42-login"], ["origin/ENG-42-login-v2"], "ENG-42")).toBe("feat/ENG-42-login");
    expect(ticketBranch(["main"], ["origin/dev", "origin/ENG-42-login"], "ENG-42")).toBe("origin/ENG-42-login");
  });

  it("matches the key exactly", () => {
    expect(ticketBranch(["feat/ENG-4-x", "feat/ENG-420"], ["origin/XENG-42"], "ENG-42")).toBeNull();
    expect(ticketBranch(["feat/ENG-42-x"], [], "ENG-4")).toBeNull();
  });

  it("matches an Epiku story's dotted key exactly", () => {
    expect(ticketBranch(["feat/ST-1.10-other", "feat/ST-1-other", "feat/ST-1.1-sample"], [], "ST-1.1")).toBe("feat/ST-1.1-sample");
    expect(ticketBranch(["feat/ST-1.10-other"], ["origin/ST-1.1.2"], "ST-1.1")).toBeNull();
  });

  it("is null when no branch carries the key", () => {
    expect(ticketBranch(["main", "dev"], ["origin/main"], "ENG-42")).toBeNull();
  });
});
