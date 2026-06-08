import { describe, it, expect } from "vitest";
import { parseFullDiff, parseDiffForFile } from "./diffParser";

// A minimal two-file unified diff fixture.
const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,7 @@
 line1
+added_line_2
+added_line_3
 line3
-deleted_line_4
 line5
diff --git a/src/bar.ts b/src/bar.ts
index 111..222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -10,3 +10,4 @@
 context
+new_line_in_bar
 context2
`;

describe("parseDiffForFile", () => {
  it("extracts added markers for a specific file", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/foo.ts");
    const added = markers.filter((m) => m.kind === "added");
    // Lines 2 and 3 in the new file are added
    expect(added.length).toBe(2);
    expect(added[0].line).toBe(2);
    expect(added[1].line).toBe(3);
  });

  it("extracts removed-after markers for deleted lines", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/foo.ts");
    const removed = markers.filter((m) => m.kind === "removed-after");
    // deleted_line_4 was deleted; its removed-after marker goes on the line
    // that follows in the new file (line 4 after insertions, i.e., line 4).
    expect(removed.length).toBe(1);
  });

  it("returns empty array for a file not in the diff", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/not_in_diff.ts");
    expect(markers).toEqual([]);
  });

  it("parses bar.ts independently of foo.ts", () => {
    const markers = parseDiffForFile(SAMPLE_DIFF, "src/bar.ts");
    const added = markers.filter((m) => m.kind === "added");
    expect(added.length).toBe(1);
    expect(added[0].line).toBe(11);
  });

  it("returns empty array for empty diff string", () => {
    expect(parseDiffForFile("", "src/foo.ts")).toEqual([]);
  });
});

const DIFF = `diff --git a/src/greet.ts b/src/greet.ts
index 111..222 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,3 +1,3 @@
 function greet(name) {
-  return "Hi " + name
+  return \`Hello, \${name}\`
 }
`;

describe("parseFullDiff rows", () => {
  const file = parseFullDiff(DIFF)[0];
  const hunk = file.hunks[0];
  it("produces structured rows with old/new line numbers", () => {
    expect(hunk.rows.map(r => r.kind)).toEqual(["context", "del", "add", "context"]);
    expect(hunk.rows[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(hunk.rows[1]).toMatchObject({ kind: "del", oldLine: 2, newLine: null });
    expect(hunk.rows[2]).toMatchObject({ kind: "add", oldLine: null, newLine: 2 });
    expect(hunk.rows[3]).toMatchObject({ oldLine: 3, newLine: 3 });
  });
  it("pairs adjacent del/add into word-diff segments", () => {
    expect(hunk.rows[1].segments?.some(s => s.kind === "del")).toBe(true);
    expect(hunk.rows[2].segments?.some(s => s.kind === "add")).toBe(true);
  });
  it("row text drops the +/-/space sign", () => {
    expect(hunk.rows[1].text.startsWith("-")).toBe(false);
    expect(hunk.rows[1].text).toContain("Hi ");
  });
});

describe("parseDiffForFile gutter count", () => {
  it("removed-after marker carries the run length", () => {
    const diff = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,1 @@\n-a\n-b\n c\n`;
    const m = parseDiffForFile(diff, "x.ts").find(mk => mk.kind === "removed-after");
    expect(m?.count).toBe(2);
  });
  it("flushes trailing deletions of a non-final hunk (not just the last)", () => {
    // First hunk ends in a deletion ("b"); a second hunk follows. Both
    // deletion runs must yield a removed-after marker.
    const diff =
      `diff --git a/m.ts b/m.ts\n--- a/m.ts\n+++ b/m.ts\n` +
      `@@ -1,2 +1,1 @@\n a\n-b\n@@ -10,2 +9,2 @@\n c\n-d\n+e\n`;
    const removed = parseDiffForFile(diff, "m.ts").filter((mk) => mk.kind === "removed-after");
    expect(removed.length).toBe(2);
    expect(removed[0]).toMatchObject({ line: 2, count: 1 });
  });
});

describe("blank context line keeps line numbering", () => {
  it("blank context line is not dropped and line numbers stay correct", () => {
    // A blank context line in a unified diff is " " (space + nothing), NOT "".
    // The buildRows skip (line === "") must only hit the trailing split artifact.
    const d = `diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n`;
    const rows = parseFullDiff(d)[0].hunks[0].rows;
    // rows: context "a"(1,1), context ""(2,2), del "b"(3,null), add "c"(null,3)
    expect(rows.map(r => r.kind)).toEqual(["context", "context", "del", "add"]);
    expect(rows[1]).toMatchObject({ kind: "context", oldLine: 2, newLine: 2 });
    expect(rows[2]).toMatchObject({ oldLine: 3 });
  });
});
