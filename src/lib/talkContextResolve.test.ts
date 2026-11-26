import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileChecked = vi.fn();
const readFileLines = vi.fn();
const fileMeta = vi.fn();
const getGitDiff = vi.fn();
const getStagedDiff = vi.fn();
const secretScanText = vi.fn();
const listWorkspaceFiles = vi.fn();
vi.mock("./ipc", () => ({
  ipc: { readFileChecked, readFileLines, fileMeta, getGitDiff, getStagedDiff, secretScanText, listWorkspaceFiles },
}));

const { expandDraft, joinBlocks, resolveContextBlock, resolveContextBlocks, scanContextBlocks, withContext } =
  await import("./talkContextResolve");
const { blockBody, parseSentContext, typedText } = await import("./sentContext");
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
    expect(block.scan).toEqual([{ label: "src/a.ts", text: "x", wholeFile: true }]);
    expect(readFileChecked).toHaveBeenCalledWith("/w/src/a.ts", 64_000);
  });

  it("reads only a range's lines, saying which of how many", async () => {
    readFileLines.mockResolvedValue({ kind: "text", content: "2\n3", start: 2, end: 3, total: 5, cut: false });
    const block = await resolveContextBlock(one("src/a.ts#L2-3"), "/w", files);
    expect(block.text).toBe("\n\nsrc/a.ts · lines 2–3 of 5\n```\n2\n3\n```");
    expect(block.scan).toEqual([{ label: "src/a.ts", text: "2\n3", firstLine: 2 }]);
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
    expect(block.scan).toEqual([{ label: "@session:dev-server", text: "$ npm run dev\nready on :5173" }]);
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
    expect(block.scan).toEqual([]);
  });

  it("scans a diff per file, by the file's path, without the diff's prefixes", async () => {
    getGitDiff.mockResolvedValue(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -10,2 +10,2 @@",
        " keep",
        "-old",
        "+new",
        "diff --git a/.env b/.env",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/.env",
        "@@ -0,0 +1,2 @@",
        "+HOST=localhost",
        "+DB_PASSWORD=hunter2hunter2",
        "",
      ].join("\n"),
    );
    const block = await resolveContextBlock(one("diff"), "/w", files);
    expect(block.scan).toEqual([
      { label: "src/a.ts", text: "keep\nnew", firstLine: 10, wholeFile: false },
      { label: "src/a.ts", text: "old", firstLine: 11, wholeFile: false },
      { label: ".env", text: "HOST=localhost\nDB_PASSWORD=hunter2hunter2", firstLine: 1, wholeFile: true },
    ]);
    // What is sent is still the diff itself.
    expect(block.text).toContain("+DB_PASSWORD=hunter2hunter2");
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
    secretScanText.mockImplementation(async ([b]: { label: string; firstLine?: number }[]) =>
      b.firstLine === 1 ? { findings: [finding("src/a.ts")], total: 1, partial: false } : { findings: [], total: 0, partial: false },
    );
    getGitDiff.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+t\n");
    const blocks = await resolveContextBlocks(extractContextRefs("@src/a.ts @diff", cat), "/w", files);
    const verdict = await scanContextBlocks(blocks);
    expect(secretScanText).toHaveBeenCalledTimes(2);
    expect(verdict?.flagged).toEqual(new Set([1]));
    expect(verdict?.refusal).toMatchObject({ total: 1, findings: [{ file: "src/a.ts", kind: "GitHub token" }] });
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

  it("holds a block whose scan can't run, as one that couldn't be checked", async () => {
    secretScanText.mockRejectedValue(new Error("settings unreadable"));
    getGitDiff.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+t\n");
    const blocks = await resolveContextBlocks(extractContextRefs("@src/a.ts @diff", cat), "/w", files);
    const verdict = await scanContextBlocks(blocks);
    expect(verdict?.flagged).toEqual(new Set([0, 1]));
    expect(verdict?.unchecked).toEqual(new Set([0, 1]));
    expect(verdict?.refusal).toEqual({ findings: [], total: 0, partial: true, fingerprint: "", unchecked: ["@src/a.ts", "@diff"] });
    const sent = joinBlocks(blocks, verdict!.flagged, verdict!.unchecked);
    expect(sent).toBe(
      "\n\nsrc/a.ts _(not included: couldn't be checked for secrets)_\n\ndiff _(not included: couldn't be checked for secrets)_",
    );
  });

  it("holds a finding and an unchecked block together", async () => {
    secretScanText.mockImplementation(async ([b]: { label: string; wholeFile?: boolean }[]) => {
      if (b.wholeFile) throw new Error("scan stopped");
      return { findings: [finding("src/a.ts")], total: 1, partial: false };
    });
    getGitDiff.mockResolvedValue("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n+t\n");
    const blocks = await resolveContextBlocks(extractContextRefs("@src/a.ts @diff", cat), "/w", files);
    const verdict = await scanContextBlocks(blocks);
    expect(verdict?.flagged).toEqual(new Set([0, 1]));
    expect(verdict?.unchecked).toEqual(new Set([0]));
    expect(verdict?.refusal).toMatchObject({ total: 1, partial: true, unchecked: ["@src/a.ts"] });
    const sent = joinBlocks(blocks, verdict!.flagged, verdict!.unchecked);
    expect(sent).toContain("src/a.ts _(not included: couldn't be checked for secrets)_");
    expect(sent).toContain("diff _(not included: possible secret)_");
  });

  it("flags a secret git wrote after a hunk header's @@", async () => {
    // Fake, token-shaped: what the GitHub-token rule matches.
    const token = ["gh", "p_"].join("") + "Zq8LmT2vXc9RpW4nKs7YbH1dFg6JuE3aQo5V";
    const tokenRule = /gh[p]_[A-Za-z0-9]{36}/;
    secretScanText.mockImplementation(async (inputs: { label: string; text: string; firstLine?: number }[]) => {
      const hit = inputs.find((b) => tokenRule.test(b.text));
      return hit
        ? { findings: [{ ...finding(hit.label), line: hit.firstLine ?? 1 }], total: 1, partial: false }
        : { findings: [], total: 0, partial: false };
    });
    getGitDiff.mockResolvedValue(
      [
        "diff --git a/deploy.sh b/deploy.sh",
        "index 1..2 100644",
        "--- a/deploy.sh",
        "+++ b/deploy.sh",
        `@@ -5,4 +5,4 @@ GITHUB_TOKEN=${token}`,
        " 4",
        " 5",
        " 6",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
    const blocks = await resolveContextBlocks(extractContextRefs("@diff", cat), "/w", files);
    // Sent to the model as part of the diff…
    expect(blocks[0].text).toContain(`@@ GITHUB_TOKEN=${token}`);
    const verdict = await scanContextBlocks(blocks);
    // …so it is held, and the finding names the file.
    expect(verdict?.flagged).toEqual(new Set([0]));
    expect(verdict?.refusal.findings).toEqual([expect.objectContaining({ file: "deploy.sh", line: 4 })]);
  });

  it("records where each block sits, so the row reads back as typed (#1150)", async () => {
    const blocks = await resolveContextBlocks(extractContextRefs("@src/a.ts @diff", cat), "/w", files);
    // Offsets are UTF-16 units: an emoji counts two.
    const typed = "¿qué pasa? 😀 @src/a.ts @diff";
    const { content, context } = withContext(typed, blocks, new Set([1]));
    expect(content).toBe(typed + joinBlocks(blocks, new Set([1])));
    const sent = parseSentContext(JSON.stringify(context), content)!;
    expect(typedText(content, sent)).toBe(typed);
    expect(blockBody(content, sent[0])).toBe("src/a.ts\n```\nk\n```");
    expect(sent[0]).toMatchObject({ token: "src/a.ts", kind: "file", label: "a.ts" });
    expect(sent[1]).toMatchObject({ token: "diff", label: "diff", notIncluded: "possible secret" });
    // A record that doesn't fit its content is no record.
    expect(parseSentContext(JSON.stringify([{ ...context[0], end: 9_999 }]), content)).toBeNull();
    expect(parseSentContext("not json", content)).toBeNull();
  });

  it("resolves a resent draft fresh, leaving a flagged block out (#1150)", async () => {
    listWorkspaceFiles.mockResolvedValue(files);
    secretScanText.mockResolvedValue({ findings: [finding("src/a.ts")], total: 1, partial: false });
    const sent = await expandDraft("look @src/a.ts", "/w", []);
    expect(sent.content).toBe("look @src/a.ts\n\nsrc/a.ts _(not included: possible secret)_");
    expect(sent.context).toEqual([expect.objectContaining({ notIncluded: "possible secret" })]);
    expect(await expandDraft("no tokens here", "/w", [])).toEqual({ content: "no tokens here", context: [] });
  });
});
