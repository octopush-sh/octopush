import { describe, it, expect } from "vitest";
import {
  CONTEXT_CAP,
  FOLDER_MAX_ENTRIES,
  MAX_MENTIONS,
  capRefs,
  capTail,
  capText,
  fenced,
  quoteToken,
  unquoteGitPath,
  chipLabel,
  contextMentionItems,
  diffForFile,
  diffScanInputs,
  dirsOf,
  extractContextRefs,
  formatFolderListing,
  joinDiffs,
  joinWrappedRows,
  parseLineRange,
  rangeToken,
  removeContextToken,
  sessionRefs,
  sliceLines,
  stripAnsi,
  tailLines,
  type ContextCatalog,
} from "./talkContext";

const files = ["src/a.ts", "src/lib/b.ts", "README.md"];
const sessions = sessionRefs([
  { id: "t1", label: "npm run dev" },
  { id: "t2", label: "zsh" },
  { id: "t3", label: "zsh" },
]);
const cat: ContextCatalog = { files: new Set(files), dirs: dirsOf(files), sessions };

describe("talkContext — parsing", () => {
  it("collects every ancestor folder of the catalog", () => {
    expect([...dirsOf(files)].sort()).toEqual(["src", "src/lib"]);
  });

  it("gives sessions unique kebab slugs", () => {
    expect(sessions.map((s) => s.slug)).toEqual(["npm-run-dev", "zsh", "zsh-2"]);
  });

  it("parses line ranges, single lines and reversed ranges", () => {
    expect(parseLineRange("src/a.ts#L10-40")).toEqual({ path: "src/a.ts", start: 10, end: 40 });
    expect(parseLineRange("src/a.ts#L7")).toEqual({ path: "src/a.ts", start: 7, end: 7 });
    expect(parseLineRange("src/a.ts#L9-L3")).toEqual({ path: "src/a.ts", start: 3, end: 9 });
    expect(parseLineRange("src/a.ts")).toBeNull();
    expect(rangeToken("a.ts", 5, 5)).toBe("a.ts#L5");
    expect(rangeToken("a.ts", 5, 10)).toBe("a.ts#L5-10");
  });

  it("resolves files, ranges, folders, sessions and the diff; leaves prose alone", () => {
    const text =
      "Why does @src/a.ts#L10-40 fail? See @src/lib/, @session:npm-run-dev and @diff:src/a.ts. " +
      "Also @README.md, @diff, mail me@x.io, @nope.ts and @session (ambiguous).";
    const refs = extractContextRefs(text, cat);
    expect(refs.map((r) => [r.kind, r.token])).toEqual([
      ["file", "src/a.ts#L10-40"],
      ["folder", "src/lib/"],
      ["session", "session:npm-run-dev"],
      ["diff", "diff:src/a.ts"],
      ["file", "README.md"],
      ["diff", "diff"],
    ]);
    expect(refs[0]).toMatchObject({ path: "src/a.ts", range: { start: 10, end: 40 } });
    expect(refs[2]).toMatchObject({ session: { id: "t1" } });
  });

  it("resolves a bare @session only when the workspace has one session", () => {
    const one = { ...cat, sessions: sessionRefs([{ id: "t9", label: "zsh" }]) };
    expect(extractContextRefs("@session", one)).toMatchObject([{ kind: "session", session: { id: "t9" } }]);
    expect(extractContextRefs("@session", cat)).toEqual([]);
  });

  it("removes one token (and its trailing space) from the draft", () => {
    expect(removeContextToken("look at @src/a.ts#L1-2 please", "src/a.ts#L1-2")).toBe("look at please");
    expect(removeContextToken("@diff, then @diff:src/a.ts", "diff")).toBe(", then @diff:src/a.ts");
    expect(removeContextToken("(@src/lib/)", "src/lib/")).toBe("()");
  });

  it("never removes a longer token that starts with the one asked for", () => {
    expect(removeContextToken("see @diff:src/a.ts and @diff", "diff")).toBe("see @diff:src/a.ts and ");
    expect(removeContextToken("tail @session:zsh then @session", "session")).toBe("tail @session:zsh then ");
    expect(removeContextToken("@src/a.ts.orig vs @src/a.ts.", "src/a.ts")).toBe("@src/a.ts.orig vs .");
    expect(removeContextToken("only @diff:src/a.ts", "diff")).toBe("only @diff:src/a.ts");
  });

  it("reads a quoted token with a space as one, and removes it quoted", () => {
    const spaced: ContextCatalog = { ...cat, files: new Set([...files, "docs/my notes.md"]) };
    const text = 'see @"docs/my notes.md#L3-9" and @"diff:docs/my notes.md", not @docs/my';
    expect(extractContextRefs(text, spaced).map((r) => [r.kind, r.token])).toEqual([
      ["file", "docs/my notes.md#L3-9"],
      ["diff", "diff:docs/my notes.md"],
    ]);
    expect(removeContextToken(text, "docs/my notes.md#L3-9")).toBe('see and @"diff:docs/my notes.md", not @docs/my');
    expect(quoteToken("docs/my notes.md#L3")).toBe('"docs/my notes.md#L3"');
    expect(quoteToken("src/a.ts")).toBe("src/a.ts");
  });

  it("attaches at most MAX_MENTIONS and counts the rest", () => {
    const many = Array.from({ length: MAX_MENTIONS + 2 }, (_, i) => `src/f${i}.ts`);
    const big: ContextCatalog = { ...cat, files: new Set(many) };
    const { kept, over } = capRefs(extractContextRefs(many.map((f) => `@${f}`).join(" "), big));
    expect(kept).toHaveLength(MAX_MENTIONS);
    expect(kept[0].token).toBe("src/f0.ts");
    expect(over).toBe(2);
    expect(capRefs(extractContextRefs("@src/a.ts", cat)).over).toBe(0);
  });

  it("labels chips by basename, range, folder, session and diff", () => {
    const labels = extractContextRefs("@src/lib/b.ts#L2-3 @src/lib/ @session:zsh-2 @diff:src/a.ts", cat).map(chipLabel);
    expect(labels).toEqual(["b.ts#L2-3", "lib/", "zsh", "diff · a.ts"]);
  });
});

describe("talkContext — popover rows", () => {
  it("offers diff and a session first on an empty query, then folders and files", () => {
    const items = contextMentionItems("", files, cat.dirs, sessions);
    expect(items.slice(0, 2)).toEqual(["diff", "session:npm-run-dev"]);
    expect(items).toContain("src/");
  });

  it("lists every session for a `ses` query and filters after `session:`", () => {
    expect(contextMentionItems("ses", files, cat.dirs, sessions)).toEqual([
      "session:npm-run-dev",
      "session:zsh",
      "session:zsh-2",
    ]);
    expect(contextMentionItems("session:zsh", files, cat.dirs, sessions)).toEqual(["session:zsh", "session:zsh-2"]);
  });

  it("ranks files after `diff:` and ranks a folder by its own name", () => {
    expect(contextMentionItems("diff:b.ts", files, cat.dirs, sessions)).toEqual(["diff:src/lib/b.ts"]);
    expect(contextMentionItems("lib", files, cat.dirs, sessions)[0]).toBe("src/lib/");
  });
});

describe("talkContext — blocks", () => {
  it("slices 1-based lines, clamped to the file", () => {
    expect(sliceLines("a\nb\nc\nd", 2, 3)).toEqual({ text: "b\nc", start: 2, end: 3, total: 4 });
    expect(sliceLines("a\nb", 2, 99)).toEqual({ text: "b", start: 2, end: 2, total: 2 });
  });

  it("keeps a buffer's last lines, ignoring the blank rows under the prompt", () => {
    expect(tailLines(["1", "2", "3", "", "  "], 2)).toEqual(["2", "3"]);
  });

  it("strips colour, cursor and title escapes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x1b[2K")).toBe("red ok");
  });

  it("finds one file's section of a unified diff", () => {
    const diff =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n" +
      "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-r\n+s\n";
    expect(diffForFile(diff, "README.md")).toBe("diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-r\n+s");
    expect(diffForFile(diff, "src/a.ts")).toContain("+y");
    expect(diffForFile(diff, "src/a.ts")).not.toContain("README");
    expect(diffForFile(diff, "other.ts")).toBe("");
  });

  it("finds a file git quoted in the header (non-ASCII, a quote)", () => {
    expect(unquoteGitPath('"a/caf\\303\\251.ts"')).toBe("a/café.ts");
    expect(unquoteGitPath('"b/say \\"hi\\".md"')).toBe('b/say "hi".md');
    expect(unquoteGitPath("a/plain.ts")).toBe("a/plain.ts");
    const diff =
      'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n+x\n' +
      'diff --git a/old.ts "b/say \\"hi\\".md"\n+y\n' +
      "diff --git a/my file.ts b/my file.ts\n+z\n";
    expect(diffForFile(diff, "src/café.ts")).toBe('diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n+x');
    expect(diffForFile(diff, 'say "hi".md')).toContain("+y");
    expect(diffForFile(diff, "old.ts")).toContain("+y");
    expect(diffForFile(diff, "my file.ts")).toContain("+z");
  });

  it("splits a diff into what the secret guard reads: each file's own lines, by its path", () => {
    const diff = [
      "# Staged",
      'diff --git "a/caf\\303\\251.env" "b/caf\\303\\251.env"',
      "--- \"a/caf\\303\\251.env\"",
      "+++ \"b/caf\\303\\251.env\"",
      "@@ -3,3 +3,3 @@",
      " A=1",
      "-B=2",
      "-C=3",
      "+B=4",
      "\\ No newline at end of file",
      "@@ -20 +20 @@",
      "+late",
      "",
      "# Not staged",
      "diff --git a/id_rsa b/id_rsa",
      "new file mode 100644",
      "Binary files /dev/null and b/id_rsa differ",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
      "… (cut at 64k characters)",
    ].join("\n");
    expect(diffScanInputs(diff)).toEqual([
      { label: "café.env", text: "A=1\nB=4", firstLine: 3, wholeFile: false },
      { label: "café.env", text: "B=2\nC=3", firstLine: 4, wholeFile: false },
      { label: "café.env", text: "late", firstLine: 20, wholeFile: false },
      { label: "id_rsa", text: "", firstLine: 1, wholeFile: true },
      { label: "gone.ts", text: "x\ny", firstLine: 1, wholeFile: false },
    ]);
    expect(diffScanInputs("(no changes)")).toEqual([]);
  });

  it("fences a block with more backticks than its content holds", () => {
    expect(fenced("h", "x")).toBe("\n\nh\n```\nx\n```");
    expect(fenced("h", "a\n````\nb", "diff")).toBe("\n\nh\n`````diff\na\n````\nb\n`````");
  });

  it("lists a folder relative to itself with sizes, and says what it left out", () => {
    const listing = formatFolderListing("src", [
      { path: "src/a.ts", size: 812 },
      { path: "src/lib/b.ts", size: 14 * 1024 },
      { path: "src/c.png", size: null },
    ]);
    expect(listing).toBe("a.ts  812 B\nlib/b.ts  14 KB\nc.png  ?");
    const many = Array.from({ length: FOLDER_MAX_ENTRIES + 3 }, (_, i) => ({ path: `src/f${i}`, size: 1 }));
    expect(formatFolderListing("src", many).split("\n").pop()).toBe("… 3 more not listed");
  });

  it("rejoins soft-wrapped rows without losing a space at the wrap", () => {
    expect(
      joinWrappedRows([
        { text: "$ echo hello ", wrapped: false },
        { text: "world        ", wrapped: true },
        { text: "hello world  ", wrapped: false },
        { text: "             ", wrapped: false },
      ]),
    ).toEqual(["$ echo hello world", "hello world", ""]);
  });

  it("keeps a tail's newest lines under the cap, counting what it kept", () => {
    expect(capTail(["a", "b"])).toEqual({ text: "a\nb", lines: 2, cut: false });
    const half = "x".repeat(CONTEXT_CAP / 2);
    const capped = capTail(["old", half, half.replace(/x/g, "y")]);
    expect(capped.cut).toBe(true);
    expect(capped.lines).toBe(1);
    expect(capped.text).toBe(half.replace(/x/g, "y"));
    const long = capTail(["a".repeat(10) + "z".repeat(CONTEXT_CAP)]);
    expect(long).toEqual({ text: "z".repeat(CONTEXT_CAP), lines: 1, cut: true });
  });

  it("joins the staged and not-staged diffs under their own labels", () => {
    expect(joinDiffs("+s\n", "+u\n")).toBe("# Staged\n+s\n\n# Not staged\n+u");
    expect(joinDiffs("+s\n", "")).toBe("# Staged\n+s");
    expect(joinDiffs("", "")).toBe("");
  });

  it("caps a block at 64k and says so", () => {
    expect(capText("short")).toBe("short");
    const capped = capText("x".repeat(CONTEXT_CAP + 10));
    expect(capped.endsWith("(cut at 64k characters)")).toBe(true);
    expect(capped.length).toBeLessThan(CONTEXT_CAP + 40);
  });
});
