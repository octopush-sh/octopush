import { describe, it, expect } from "vitest";
import type { FileChange } from "./types";
import { DIFF_TRUNCATED_MARKER } from "./reviewSource";
import {
  changeStats,
  changesMeta,
  pathTail,
  runChangesReader,
  sameChangeStats,
  statLabel,
  STATUS_LETTER,
} from "./runChanges";

const file = (path: string, status: FileChange["status"] = "modified"): FileChange => ({
  path,
  status,
  staged: false,
  unstaged: true,
  conflicted: status === "conflicted",
});

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 111..222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " keep",
  "-old",
  "+new",
  "+++i;",
  "diff --git a/docs/plan.md b/docs/plan.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/plan.md",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
].join("\n");

describe("changeStats", () => {
  it("counts hunk lines per file and never a header", () => {
    const s = changeStats(DIFF);
    expect(s.complete).toBe(true);
    // `+++i;` is content (inside the hunk); `+++ b/…` is a header (outside).
    expect(s.byFile["src/app.ts"]).toEqual({ added: 2, removed: 1 });
    expect(s.byFile["docs/plan.md"]).toEqual({ added: 2, removed: 0 });
  });

  it("has no entry for a file with no hunk", () => {
    expect(changeStats(DIFF).byFile["logo.png"]).toBeUndefined();
    expect(changeStats("")).toEqual({ byFile: {}, complete: true });
  });

  it("drops the file a truncated diff was cut in, and says the diff is not whole", () => {
    const cut = `${DIFF.split("diff --git a/logo.png")[0]}\n${DIFF_TRUNCATED_MARKER}\n`;
    const s = changeStats(cut);
    expect(s.complete).toBe(false);
    expect(s.byFile["src/app.ts"]).toEqual({ added: 2, removed: 1 });
    expect(s.byFile["docs/plan.md"]).toBeUndefined();
  });

  it("compares by value", () => {
    expect(sameChangeStats(changeStats(DIFF), changeStats(DIFF))).toBe(true);
    expect(sameChangeStats(changeStats(DIFF), changeStats(DIFF.replace("+two", " two")))).toBe(false);
    expect(sameChangeStats(changeStats(DIFF), changeStats(""))).toBe(false);
  });
});

describe("changesMeta", () => {
  it("reads `N files · +A −R` over the listed files", () => {
    const files = [file("src/app.ts"), file("docs/plan.md", "new"), file("logo.png")];
    expect(changesMeta(files, changeStats(DIFF))).toBe("3 files · +4 −1");
    expect(changesMeta([file("docs/plan.md", "new")], changeStats(DIFF))).toBe("1 file · +2");
  });

  it("gives the count alone when there is no whole line total to give", () => {
    // Staged-only or binary changes: the working diff holds no lines for them.
    expect(changesMeta([file("logo.png")], changeStats(DIFF))).toBe("1 file");
    expect(changesMeta([file("src/app.ts")], { byFile: { "src/app.ts": { added: 2, removed: 1 } }, complete: false })).toBe(
      "1 file",
    );
  });

  it("is null for a clean tree", () => {
    expect(changesMeta([], changeStats(""))).toBeNull();
  });
});

describe("row atoms", () => {
  it("labels a stat with only the sides that have lines", () => {
    expect(statLabel({ added: 84, removed: 12 })).toBe("+84 −12");
    expect(statLabel({ added: 0, removed: 11 })).toBe("−11");
    expect(statLabel({ added: 0, removed: 0 })).toBe("");
  });

  it("uses Review's status letters", () => {
    expect([STATUS_LETTER.new, STATUS_LETTER.modified, STATUS_LETTER.deleted, STATUS_LETTER.conflicted]).toEqual([
      "N",
      "M",
      "D",
      "!",
    ]);
  });

  it("pins the file name, within bounds", () => {
    expect(pathTail("src/main/resources/config.js")).toBe("/config.js".length);
    expect(pathTail("pom.xml")).toBe(8);
    expect(pathTail("docs/a-very-long-file-name-for-a-plan.md")).toBe(20);
  });
});

describe("runChangesReader", () => {
  // A workspace branch with no upstream: ahead/behind are 0/0 whatever is
  // committed, so a clean tree has one signature before and after a commit.
  const CLEAN = "feat/x|0|0|";
  const DIRTY = "feat/x|0|0|src/a.ts:modified:0:1";

  /** One tick, reading what it is told to and saying so. */
  function tick(reader: ReturnType<typeof runChangesReader>, sig: string, dirty: boolean) {
    const read = reader.next(sig, dirty);
    if (read === "ahead") reader.aheadRead(sig);
    return read;
  }

  it("reads the count once per clean state, not on every tick", () => {
    const r = runChangesReader();
    expect(tick(r, CLEAN, false)).toBe("ahead");
    expect(tick(r, CLEAN, false)).toBeNull();
    expect(tick(r, CLEAN, false)).toBeNull();
  });

  it("reads the working diff on every dirty tick", () => {
    const r = runChangesReader();
    expect(tick(r, DIRTY, true)).toBe("diff");
    expect(tick(r, DIRTY, true)).toBe("diff");
  });

  it("reads the count again after clean, edits, a commit and clean, though the signature is the same", () => {
    const r = runChangesReader();
    expect(tick(r, CLEAN, false)).toBe("ahead"); // nothing ahead yet
    expect(tick(r, CLEAN, false)).toBeNull();
    expect(tick(r, DIRTY, true)).toBe("diff"); // the agent edits
    expect(tick(r, DIRTY, true)).toBe("diff");
    // The agent commits: clean again, with the signature it had before.
    expect(tick(r, CLEAN, false)).toBe("ahead");
    expect(tick(r, CLEAN, false)).toBeNull();
  });

  it("reads the count again when the signature moves while clean", () => {
    const r = runChangesReader();
    expect(tick(r, CLEAN, false)).toBe("ahead");
    expect(tick(r, "feat/x|1|0|", false)).toBe("ahead"); // pushed branch, a commit pulled in
    expect(tick(r, "main|0|0|", false)).toBe("ahead"); // another branch checked out
    expect(tick(r, "main|0|0|", false)).toBeNull();
  });

  it("keeps asking until the count has been read", () => {
    const r = runChangesReader();
    expect(r.next(CLEAN, false)).toBe("ahead");
    // The read was dropped (the effect went away mid-flight): still due.
    expect(r.next(CLEAN, false)).toBe("ahead");
    r.aheadRead(CLEAN);
    expect(r.next(CLEAN, false)).toBeNull();
  });
});
