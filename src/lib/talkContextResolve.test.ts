import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileChecked = vi.fn();
const readFileLines = vi.fn();
const fileMeta = vi.fn();
const getGitDiff = vi.fn();
const getStagedDiff = vi.fn();
const secretScanText = vi.fn();
vi.mock("./ipc", () => ({
  ipc: { readFileChecked, readFileLines, fileMeta, getGitDiff, getStagedDiff, secretScanText },
}));

const { joinBlocks, resolveContextBlock, resolveContextBlocks, scanContextBlocks } = await import(
  "./talkContextResolve"
);
const { registerTerminalBuffer } = await import("./terminalBuffers");
const { dirsOf, extractContextRefs, sessionRefs } = await import("./talkContext");

const files = ["src/a.ts", "src/lib/b.ts", "docs/my notes.md"];
const cat = {
  files: new Set(files),
  dirs: dirsOf(files),
  sessions: sessionRefs([{ id: "t1", label: "dev server" }]),
};
const one = (token: string) => extractContextRefs(`@${token}`, cat)[0];
const text = async (token: string) => (await resolveContextBlock(one(token), "/w", files)).text;

describe("resolveContextBlock", () => {
  beforeEach(() => {
    readFileChecked.mockReset();
    readFileLines.mockReset();
    fileMeta.mockReset();
    getGitDiff.mockReset();
    getStagedDiff.mockReset().mockResolvedValue("");
    secretScanText.mockReset();
  });

  it("keeps a whole file's block as before: path heading, fenced contents, 64k read", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "x", size: 1, mtime: 0 });
    const block = await resolveContextBlock(one("src/a.ts"), "/w", files);
    expect(block.text).toBe("\n\nsrc/a.ts\n```\nx\n```");
    expect(block.scan).toEqual({ label: "src/a.ts", text: "x", wholeFile: true });
    expect(readFileChecked).toHaveBeenCalledWith("/w/src/a.ts", 64_000);
  });

  it("reads only a range's lines, saying which of how many", async () => {
    readFileLines.mockResolvedValue({ kind: "text", content: "2\n3", start: 2, end: 3, total: 5, cut: false });
    const block = await resolveContextBlock(one("src/a.ts#L2-3"), "/w", files);
    expect(block.text).toBe("\n\nsrc/a.ts · lines 2–3 of 5\n```\n2\n3\n```");
    expect(block.scan).toEqual({ label: "src/a.ts", text: "2\n3", firstLine: 2 });
    expect(readFileLines).toHaveBeenCalledWith("/w/src/a.ts", 2, 3, 64_000);
    expect(readFileChecked).not.toHaveBeenCalled();
  });

  it("leaves the total out when the read stopped before the file's end, and says when a range is past it", async () => {
    readFileLines.mockResolvedValue({ kind: "text", content: "7", start: 7, end: 7, total: null, cut: false });
    expect(await text("src/a.ts#L7")).toBe("\n\nsrc/a.ts · lines 7–7\n```\n7\n```");
    readFileLines.mockResolvedValue({ kind: "text", content: "", start: 90, end: 12, total: 12, cut: false });
    expect(await text("src/a.ts#L90")).toBe("\n\nsrc/a.ts#L90 _(not included: the file has 12 lines)_");
  });

  it("resolves a quoted path with a space", async () => {
    readFileLines.mockResolvedValue({ kind: "text", content: "n", start: 3, end: 3, total: 9, cut: false });
    const ref = extractContextRefs('look at @"docs/my notes.md#L3" please', cat)[0];
    expect(ref).toMatchObject({ kind: "file", path: "docs/my notes.md" });
    expect((await resolveContextBlock(ref, "/w", files)).text).toContain("docs/my notes.md · lines 3–3 of 9");
  });

  it("lists a folder with sizes, never its contents", async () => {
    fileMeta.mockImplementation(async (p: string) => ({ mtimeMs: 0, size: p.endsWith("b.ts") ? 2048 : 10 }));
    expect(await text("src/")).toBe("\n\nsrc/ · folder listing, 2 files\n```\na.ts  10 B\nlib/b.ts  2 KB\n```");
    expect(readFileChecked).not.toHaveBeenCalled();
  });

  it("attaches a session's last lines without escapes, and says when it isn't open", async () => {
    expect(await text("session:dev-server")).toContain("_(not included: not open)_");
    const off = registerTerminalBuffer("t1", () => ["$ npm run dev", "\x1b[32mready\x1b[0m on :5173", ""]);
    const block = await resolveContextBlock(one("session:dev-server"), "/w", files);
    off();
    expect(block.text).toBe('\n\nRun session "dev server" · last 2 lines\n```\n$ npm run dev\nready on :5173\n```');
    expect(block.scan).toEqual({ label: "@session:dev-server", text: "$ npm run dev\nready on :5173" });
  });

  it("cuts a long session tail at its start, keeping the newest lines", async () => {
    const big = Array.from({ length: 150 }, (_, i) => `${i}`.padEnd(1000, "."));
    const off = registerTerminalBuffer("t1", () => big);
    const block = await text("session:dev-server");
    off();
    expect(block).toContain(" · last 63 lines\n```\n… (cut at 64k characters, older lines left out)\n87.");
    expect(block.endsWith(`${big[149]}\n\`\`\``)).toBe(true);
  });

  it("attaches the workspace diff, or one file's section of it", async () => {
    getGitDiff.mockResolvedValue(
      "diff --git a/src/a.ts b/src/a.ts\n+a\ndiff --git a/src/lib/b.ts b/src/lib/b.ts\n+b\n",
    );
    expect(await text("diff")).toContain("Workspace diff (uncommitted)\n```diff\n# Not staged\ndiff --git a/src/a.ts");
    expect(await text("diff:src/lib/b.ts")).toBe(
      "\n\nDiff of src/lib/b.ts (uncommitted)\n```diff\n# Not staged\ndiff --git a/src/lib/b.ts b/src/lib/b.ts\n+b\n```",
    );
  });

  it("includes staged changes in the diff, also for a fully staged file", async () => {
    getStagedDiff.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n+staged\n");
    getGitDiff.mockResolvedValue("diff --git a/src/lib/b.ts b/src/lib/b.ts\n+b\n");
    expect(await text("diff:src/a.ts")).toBe(
      "\n\nDiff of src/a.ts (uncommitted)\n```diff\n# Staged\ndiff --git a/src/a.ts b/src/a.ts\n+staged\n```",
    );
    expect(await text("diff")).toContain(
      "# Staged\ndiff --git a/src/a.ts b/src/a.ts\n+staged\n\n# Not staged\ndiff --git a/src/lib/b.ts",
    );
  });

  it("reads the diff once for every diff token of a message", async () => {
    getGitDiff.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n+a\n");
    const refs = extractContextRefs("@diff and @diff:src/a.ts", cat);
    const blocks = await resolveContextBlocks(refs, "/w", files);
    expect(blocks).toHaveLength(2);
    expect(getGitDiff).toHaveBeenCalledTimes(1);
    expect(getStagedDiff).toHaveBeenCalledTimes(1);
  });

  it("fences content that holds a fence of its own with a longer one", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "a\n```\nb\n```", size: 1, mtime: 0 });
    expect(await text("src/a.ts")).toBe("\n\nsrc/a.ts\n````\na\n```\nb\n```\n````");
  });

  it("writes a failed read into the message instead of dropping it", async () => {
    readFileLines.mockRejectedValue(new Error("gone"));
    const block = await resolveContextBlock(one("src/a.ts#L1"), "/w", files);
    expect(block.text).toBe("\n\nsrc/a.ts#L1 _(not included: unreadable)_");
    expect(block.scan).toBeNull();
  });
});

describe("scanContextBlocks", () => {
  beforeEach(() => {
    readFileChecked.mockReset().mockResolvedValue({ kind: "text", content: "k", size: 1, mtime: 0 });
    getGitDiff.mockReset().mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n+t\n");
    getStagedDiff.mockReset().mockResolvedValue("");
    secretScanText.mockReset();
  });

  const finding = (file: string) => ({ file, line: 2, rule: "github-token", kind: "GitHub token", yours: false });

  it("scans each block on its own and names the flagged ones", async () => {
    secretScanText.mockImplementation(async ([b]: { label: string }[]) =>
      b.label === "@diff" ? { findings: [finding("@diff")], total: 1, partial: false } : { findings: [], total: 0, partial: false },
    );
    const blocks = await resolveContextBlocks(extractContextRefs("@src/a.ts @diff", cat), "/w", files);
    const verdict = await scanContextBlocks(blocks);
    expect(secretScanText).toHaveBeenCalledTimes(2);
    expect(verdict?.flagged).toEqual(new Set([1]));
    expect(verdict?.refusal).toMatchObject({ total: 1, findings: [{ file: "@diff", kind: "GitHub token" }] });
    // Left out, the block says so in its place; never its value.
    const sent = joinBlocks(blocks, verdict!.flagged);
    expect(sent).toContain("src/a.ts\n```\nk\n```");
    expect(sent).toContain("diff _(not included: possible secret)_");
    expect(sent).not.toContain("+t");
    expect(joinBlocks(blocks)).toContain("+t");
  });

  it("asks nothing when the guard is off or finds nothing", async () => {
    secretScanText.mockResolvedValue(null);
    const blocks = await resolveContextBlocks(extractContextRefs("@src/a.ts", cat), "/w", files);
    expect(await scanContextBlocks(blocks)).toBeNull();
    secretScanText.mockResolvedValue({ findings: [], total: 0, partial: false });
    expect(await scanContextBlocks(blocks)).toBeNull();
  });
});
