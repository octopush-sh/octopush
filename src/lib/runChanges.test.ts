import { describe, it, expect } from "vitest";
import type { FileChange, GitStatus } from "./types";
import { DIFF_TRUNCATED_MARKER } from "./reviewSource";
import {
  changeStats,
  changesMeta,
  gitStatusSig,
  NO_CHANGE_STATS,
  pathTail,
  runChangesReader,
  runChangesTick,
  sameChangeStats,
  statLabel,
  STATUS_LETTER,
  type ChangeStats,
  type CommitsAhead,
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

/** A workspace branch with no upstream (ahead/behind stay 0/0), at `head`. */
const status = (head: string | null, files: FileChange[] = []): GitStatus => ({
  branch: "feat/x",
  changedFiles: files,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  conflicted: 0,
  aheadBehindKnown: true,
  operation: null,
  head,
});

describe("gitStatusSig", () => {
  it("moves when HEAD does, though nothing else in the status changed", () => {
    expect(gitStatusSig(status("aaa"))).not.toBe(gitStatusSig(status("bbb")));
    expect(gitStatusSig(status("aaa"))).toBe(gitStatusSig(status("aaa")));
  });

  it("moves with the changed files", () => {
    expect(gitStatusSig(status("aaa"))).not.toBe(gitStatusSig(status("aaa", [file("src/a.ts")])));
  });
});

describe("runChangesTick (App's git poll, Run's Changes section)", () => {
  /** App's side of the tick: the IPC reads it would make and the state it
   *  would hold, counting the reads. */
  function harness() {
    const state = { stats: NO_CHANGE_STATS as ChangeStats, ahead: null as CommitsAhead | null };
    const reads = { diff: 0, ahead: 0 };
    let commits = 0;
    let diff = "";
    let cancelled = false;
    const reader = runChangesReader();
    const io = {
      readDiff: async () => {
        reads.diff++;
        return diff;
      },
      readAhead: async (): Promise<CommitsAhead | null> => {
        reads.ahead++;
        return { commits, base: "main", mergeBase: "m0" };
      },
      setStats: (u: (p: ChangeStats) => ChangeStats) => {
        state.stats = u(state.stats);
      },
      setAhead: (u: (p: CommitsAhead | null) => CommitsAhead | null) => {
        state.ahead = u(state.ahead);
      },
      cancelled: () => cancelled,
    };
    return {
      state,
      reads,
      io,
      tick: (s: GitStatus | null) => runChangesTick(reader, s, io),
      commit: () => commits++,
      setDiff: (d: string) => {
        diff = d;
      },
      cancel: () => {
        cancelled = true;
      },
    };
  }

  it("counts the commits ahead once per clean state, and keeps the same state object on a quiet tick", async () => {
    const h = harness();
    await h.tick(status("h0"));
    expect(h.state.ahead).toEqual({ commits: 0, base: "main", mergeBase: "m0" });
    const before = h.state.ahead;
    await h.tick(status("h0"));
    await h.tick(status("h0"));
    expect(h.reads.ahead).toBe(1);
    expect(h.state.ahead).toBe(before);
  });

  it("recounts after a commit no dirty tick saw (made while the window was hidden, or within one tick)", async () => {
    const h = harness();
    await h.tick(status("h0"));
    expect(h.state.ahead?.commits).toBe(0);
    // The agent edits and commits while the poll skips ticks; the focus
    // refresh then sees a clean tree again, at a new HEAD.
    h.commit();
    await h.tick(status("h1"));
    expect(h.reads.ahead).toBe(2);
    expect(h.state.ahead?.commits).toBe(1);
    // `reset --hard` back: HEAD moves again, and so does the count.
    h.commit();
    await h.tick(status("h0"));
    expect(h.reads.ahead).toBe(3);
  });

  it("reads the working diff while dirty, voids the count, and recounts once clean", async () => {
    const h = harness();
    await h.tick(status("h0"));
    expect(h.state.ahead).not.toBeNull();
    h.setDiff(["diff --git a/src/a.ts b/src/a.ts", "@@ -1 +1,2 @@", " keep", "+new"].join("\n"));
    await h.tick(status("h0", [file("src/a.ts")]));
    expect(h.state.ahead).toBeNull();
    expect(h.state.stats.byFile["src/a.ts"]).toEqual({ added: 1, removed: 0 });
    const stats = h.state.stats;
    await h.tick(status("h0", [file("src/a.ts")]));
    expect(h.reads.diff).toBe(2);
    expect(h.state.stats).toBe(stats);
    h.commit();
    await h.tick(status("h1"));
    expect(h.state.stats).toEqual(NO_CHANGE_STATS);
    expect(h.state.ahead?.commits).toBe(1);
  });

  it("writes nothing once the poll went away mid-read, and asks again next time", async () => {
    const h = harness();
    const reader = runChangesReader();
    h.cancel();
    await runChangesTick(reader, status("h0"), h.io);
    expect(h.state.ahead).toBeNull();
    expect(reader.next(gitStatusSig(status("h0")), false)).toBe("ahead");
  });

  it("never asks for a count without a workspace", async () => {
    const h = harness();
    await runChangesTick(runChangesReader(), status("h0"), { ...h.io, readAhead: null });
    expect(h.reads.ahead).toBe(0);
    expect(h.state.ahead).toBeNull();
  });
});
