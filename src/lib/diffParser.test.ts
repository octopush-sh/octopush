import { describe, it, expect } from "vitest";
import { parseDiffForFile } from "./diffParser";

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
