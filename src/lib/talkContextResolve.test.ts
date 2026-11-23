import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileChecked = vi.fn();
const fileMeta = vi.fn();
const getGitDiff = vi.fn();
const getStagedDiff = vi.fn();
vi.mock("./ipc", () => ({ ipc: { readFileChecked, fileMeta, getGitDiff, getStagedDiff } }));

const { resolveContextBlock } = await import("./talkContextResolve");
const { registerTerminalBuffer } = await import("./terminalBuffers");
const { dirsOf, extractContextRefs, sessionRefs } = await import("./talkContext");

const files = ["src/a.ts", "src/lib/b.ts"];
const cat = {
  files: new Set(files),
  dirs: dirsOf(files),
  sessions: sessionRefs([{ id: "t1", label: "dev server" }]),
};
const one = (token: string) => extractContextRefs(`@${token}`, cat)[0];

describe("resolveContextBlock", () => {
  beforeEach(() => {
    readFileChecked.mockReset();
    fileMeta.mockReset();
    getGitDiff.mockReset();
    getStagedDiff.mockReset().mockResolvedValue("");
  });

  it("keeps a whole file's block as before: path heading, fenced contents, 64k read", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "x", size: 1, mtime: 0 });
    expect(await resolveContextBlock(one("src/a.ts"), "/w", files)).toBe("\n\nsrc/a.ts\n```\nx\n```");
    expect(readFileChecked).toHaveBeenCalledWith("/w/src/a.ts", 64_000);
  });

  it("sends only a range's lines, saying which of how many", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "1\n2\n3\n4\n5", size: 9, mtime: 0 });
    expect(await resolveContextBlock(one("src/a.ts#L2-3"), "/w", files)).toBe(
      "\n\nsrc/a.ts · lines 2–3 of 5\n```\n2\n3\n```",
    );
  });

  it("lists a folder with sizes, never its contents", async () => {
    fileMeta.mockImplementation(async (p: string) => ({ mtimeMs: 0, size: p.endsWith("b.ts") ? 2048 : 10 }));
    const block = await resolveContextBlock(one("src/"), "/w", files);
    expect(block).toBe("\n\nsrc/ · folder listing, 2 files\n```\na.ts  10 B\nlib/b.ts  2 KB\n```");
    expect(readFileChecked).not.toHaveBeenCalled();
  });

  it("attaches a session's last lines without escapes, and says when it isn't open", async () => {
    const ref = one("session:dev-server");
    expect(await resolveContextBlock(ref, "/w", files)).toContain("_(not included: not open)_");
    const off = registerTerminalBuffer("t1", () => ["$ npm run dev", "\x1b[32mready\x1b[0m on :5173", ""]);
    expect(await resolveContextBlock(ref, "/w", files)).toBe(
      '\n\nRun session "dev server" · last 2 lines\n```\n$ npm run dev\nready on :5173\n```',
    );
    off();
  });

  it("cuts a long session tail at its start, keeping the newest lines", async () => {
    const big = Array.from({ length: 150 }, (_, i) => `${i}`.padEnd(1000, "."));
    const off = registerTerminalBuffer("t1", () => big);
    const block = await resolveContextBlock(one("session:dev-server"), "/w", files);
    off();
    expect(block).toContain(" · last 63 lines\n```\n… (cut at 64k characters, older lines left out)\n87.");
    expect(block.endsWith(`${big[149]}\n\`\`\``)).toBe(true);
  });

  it("attaches the workspace diff, or one file's section of it", async () => {
    getGitDiff.mockResolvedValue(
      "diff --git a/src/a.ts b/src/a.ts\n+a\ndiff --git a/src/lib/b.ts b/src/lib/b.ts\n+b\n",
    );
    expect(await resolveContextBlock(one("diff"), "/w", files)).toContain(
      "Workspace diff (uncommitted)\n```diff\n# Not staged\ndiff --git a/src/a.ts",
    );
    const file = await resolveContextBlock(one("diff:src/lib/b.ts"), "/w", files);
    expect(file).toBe(
      "\n\nDiff of src/lib/b.ts (uncommitted)\n```diff\n# Not staged\ndiff --git a/src/lib/b.ts b/src/lib/b.ts\n+b\n```",
    );
  });

  it("includes staged changes in the diff, also for a fully staged file", async () => {
    getStagedDiff.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n+staged\n");
    getGitDiff.mockResolvedValue("diff --git a/src/lib/b.ts b/src/lib/b.ts\n+b\n");
    expect(await resolveContextBlock(one("diff:src/a.ts"), "/w", files)).toBe(
      "\n\nDiff of src/a.ts (uncommitted)\n```diff\n# Staged\ndiff --git a/src/a.ts b/src/a.ts\n+staged\n```",
    );
    expect(await resolveContextBlock(one("diff"), "/w", files)).toContain(
      "# Staged\ndiff --git a/src/a.ts b/src/a.ts\n+staged\n\n# Not staged\ndiff --git a/src/lib/b.ts",
    );
  });

  it("writes a failed read into the message instead of dropping it", async () => {
    readFileChecked.mockRejectedValue(new Error("gone"));
    expect(await resolveContextBlock(one("src/a.ts#L1"), "/w", files)).toBe(
      "\n\nsrc/a.ts#L1 _(not included: unreadable)_",
    );
  });
});
