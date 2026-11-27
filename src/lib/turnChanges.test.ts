import { describe, it, expect } from "vitest";
import { turnChangesNames, turnChangesSummary, turnEnds, turnLabel, type TurnChange } from "./turnChanges";
import type { TalkBlock } from "./talkWork";

const change = (path: string, added: number, removed: number, status: TurnChange["status"] = "modified"): TurnChange => ({
  path,
  status,
  added,
  removed,
});

describe("turn changes wording", () => {
  it("counts files and lines", () => {
    const four = [change("src/a.ts", 30, 4), change("src/b.ts", 5, 2), change("new.md", 3, 0, "added"), change("x.png", 0, 0)];
    expect(turnChangesSummary(four)).toBe("4 files changed · +38 −6");
    expect(turnChangesSummary([change("a.ts", 1, 0)])).toBe("1 file changed · +1 −0");
    // A binary-only change has no line counts to show.
    expect(turnChangesSummary([change("logo.png", 0, 0)])).toBe("1 file changed");
  });

  it("lists file names without their folders", () => {
    expect(turnChangesNames([change("src/deep/a.ts", 1, 1), change("README.md", 1, 0)])).toBe("a.ts, README.md");
  });

  it("labels a turn by its ask's first line", () => {
    expect(turnLabel("\n  Fix the parser  \nand more")).toBe("Fix the parser");
    expect(turnLabel("x".repeat(50))).toBe(`${"x".repeat(40)}…`);
  });
});

describe("turnEnds", () => {
  const msg = (id: number, role: "user" | "assistant") =>
    ({ kind: "message", message: { id, role, content: "" } }) as unknown as TalkBlock;
  const work = (id: number) => ({ kind: "work", id, entries: [], calls: 0 }) as TalkBlock;

  it("maps the last block of each turn to that turn's ask", () => {
    const blocks = [msg(1, "user"), work(2), msg(3, "assistant"), msg(4, "user"), msg(5, "assistant")];
    expect([...turnEnds(blocks)]).toEqual([
      [2, 1],
      [4, 4],
    ]);
  });

  it("ends a turn with nothing after its ask on the ask itself", () => {
    expect([...turnEnds([msg(1, "user"), msg(2, "user"), work(3)])]).toEqual([
      [0, 1],
      [2, 2],
    ]);
    expect(turnEnds([]).size).toBe(0);
  });
});
