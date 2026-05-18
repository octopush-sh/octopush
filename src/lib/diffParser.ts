/**
 * Parses a unified diff string and extracts per-file line markers
 * for use with the CodeMirror diff gutter.
 */

export interface DiffLineMarker {
  /** 1-based line number in the NEW (post-diff) file. */
  line: number;
  /** "added" = this line was inserted; "removed-after" = deletions preceded this line. */
  kind: "added" | "removed-after";
}

/**
 * Extract `DiffLineMarker[]` for a single file within a unified diff.
 *
 * @param diff    Full unified diff text (output of `git diff`).
 * @param relPath Relative path of the file to extract (e.g. "src/foo.ts").
 *                Must match the path as it appears after "b/" in the diff header.
 */
export function parseDiffForFile(diff: string, relPath: string): DiffLineMarker[] {
  if (!diff) return [];

  // Split the diff into per-file sections by the "diff --git" boundary.
  const fileSections = diff.split(/^diff --git /m).slice(1);

  // Find the section for our target file.
  const targetSection = fileSections.find((section) => {
    // The first line is "a/path b/path"
    const header = section.split("\n")[0] ?? "";
    return header.includes(`b/${relPath}`);
  });

  if (!targetSection) return [];

  const markers: DiffLineMarker[] = [];
  const lines = targetSection.split("\n");

  // Current position in the NEW file (1-based).
  let newLine = 0;
  // Whether we have seen at least one hunk header yet.
  let inHunk = false;
  // Count of consecutive "-" lines pending a "removed-after" marker.
  let pendingRemovals = 0;

  for (const line of lines) {
    // Hunk header: @@ -old_start,old_count +new_start,new_count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10) - 1; // will be incremented on first context/+ line
      pendingRemovals = 0;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue; // still in the file header before the first hunk

    if (line.startsWith("+") && !line.startsWith("+++")) {
      // Flush any pending removals: they happened just before this new line.
      if (pendingRemovals > 0) {
        markers.push({ line: newLine + 1, kind: "removed-after" });
        pendingRemovals = 0;
      }
      newLine++;
      markers.push({ line: newLine, kind: "added" });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      pendingRemovals++;
    } else if (!line.startsWith("\\")) {
      // Context line (or blank): flush pending removals first.
      if (pendingRemovals > 0) {
        markers.push({ line: newLine + 1, kind: "removed-after" });
        pendingRemovals = 0;
      }
      newLine++;
    }
  }

  // Flush any removals at the end of a hunk.
  if (pendingRemovals > 0) {
    markers.push({ line: newLine + 1, kind: "removed-after" });
  }

  return markers;
}
