/**
 * Parses a unified diff string and extracts per-file line markers
 * for use with the CodeMirror diff gutter, plus full hunk structures
 * for the Review canvas Accept/Reject UI.
 */

import { wordDiff, type WordSegment } from "./wordDiff";

// ─── Full diff parse (for Review canvas) ──────────────────────────

export type DiffRowKind = "context" | "add" | "del";

export interface DiffRow {
  kind: DiffRowKind;
  /** Line content WITHOUT the +/-/space sign. */
  text: string;
  oldLine: number | null;
  newLine: number | null;
  segments?: WordSegment[];
}

export interface DiffHunk {
  /** The @@ header line. */
  header: string;
  /** All lines within this hunk (including the @@ line). */
  lines: string[];
  /** Raw text of just this hunk (suitable for git apply). */
  rawText: string;
  /** Number of added lines. */
  additions: number;
  /** Number of removed lines. */
  deletions: number;
  /** Structured rows with line numbers and optional word-diff segments. */
  rows: DiffRow[];
}

export interface DiffFile {
  /** Path as it appears in the diff (b/... side). */
  filePath: string;
  /** "modified" | "new" | "deleted" */
  changeType: "modified" | "new" | "deleted";
  /** Individual hunks parsed from the file section. */
  hunks: DiffHunk[];
  /** Full header lines for this file (diff --git, ---, +++ lines). */
  fileHeader: string;
}

/**
 * Parse a full unified diff string into a list of DiffFile objects,
 * each containing one or more DiffHunk objects.
 */
export function parseFullDiff(diff: string): DiffFile[] {
  if (!diff) return [];

  // Split into per-file sections on the "diff --git" boundary.
  const rawSections = diff.split(/^(?=diff --git )/m).filter(Boolean);

  return rawSections.map((section): DiffFile => {
    const sectionLines = section.split("\n");

    // Extract file path from the first line: "diff --git a/path b/path"
    const firstLine = sectionLines[0] ?? "";
    const pathMatch = firstLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    const filePath = pathMatch ? pathMatch[2] : firstLine;

    // Detect change type from headers.
    const isNew = sectionLines.some(
      (l) => l.startsWith("new file mode") || l.startsWith("+++ /dev/null") === false && l === "--- /dev/null",
    );
    const isDeleted = sectionLines.some(
      (l) => l.startsWith("deleted file mode") || l === "+++ /dev/null",
    );
    const changeType: DiffFile["changeType"] = isDeleted
      ? "deleted"
      : isNew || sectionLines.some((l) => l.startsWith("new file mode"))
        ? "new"
        : "modified";

    // Find where hunks start (first @@ line).
    const firstHunkIdx = sectionLines.findIndex((l) => l.startsWith("@@"));
    const fileHeaderLines = firstHunkIdx >= 0 ? sectionLines.slice(0, firstHunkIdx) : sectionLines;
    const fileHeader = fileHeaderLines.join("\n");

    // Split hunk content into individual hunks by @@ boundaries.
    const hunkLines = firstHunkIdx >= 0 ? sectionLines.slice(firstHunkIdx) : [];
    const hunks: DiffHunk[] = [];
    let currentHunkLines: string[] = [];

    for (const line of hunkLines) {
      if (line.startsWith("@@") && currentHunkLines.length > 0) {
        hunks.push(buildHunk(currentHunkLines, fileHeaderLines));
        currentHunkLines = [line];
      } else {
        currentHunkLines.push(line);
      }
    }
    if (currentHunkLines.length > 0) {
      hunks.push(buildHunk(currentHunkLines, fileHeaderLines));
    }

    return { filePath, changeType, hunks, fileHeader };
  });
}

// ─── Row helpers ──────────────────────────────────────────────────

function parseHunkHeader(header: string): { oldStart: number; newStart: number } {
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return { oldStart: m ? parseInt(m[1], 10) : 1, newStart: m ? parseInt(m[2], 10) : 1 };
}

function pairReplaceBlocks(rows: DiffRow[]): void {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind === "del") {
      let d = i; while (d < rows.length && rows[d].kind === "del") d++;
      let a = d; while (a < rows.length && rows[a].kind === "add") a++;
      const dels = rows.slice(i, d), adds = rows.slice(d, a);
      const pairs = Math.min(dels.length, adds.length);
      for (let k = 0; k < pairs; k++) {
        const wd = wordDiff(dels[k].text, adds[k].text);
        dels[k].segments = wd.old;
        adds[k].segments = wd.new;
      }
      i = a;
    } else {
      i++;
    }
  }
}

function buildRows(lines: string[]): DiffRow[] {
  const header = lines[0] ?? "";
  const { oldStart, newStart } = parseHunkHeader(header);
  let oldN = oldStart, newN = newStart;
  const rows: DiffRow[] = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue; // artifact of trailing newline in split
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+") && !line.startsWith("+++")) {
      rows.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newN++ });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      rows.push({ kind: "del", text: line.slice(1), oldLine: oldN++, newLine: null });
    } else {
      rows.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine: oldN++, newLine: newN++ });
    }
  }
  pairReplaceBlocks(rows);
  return rows;
}

/**
 * Build a DiffHunk from the raw lines of a single hunk block.
 * Prepends the file header lines so `git apply` can locate the file.
 */
function buildHunk(lines: string[], fileHeaderLines: string[]): DiffHunk {
  const header = lines[0] ?? "";
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  // rawText includes the file headers so git apply knows which file to patch.
  const rawText = [...fileHeaderLines, ...lines].join("\n") + "\n";

  return { header, lines, rawText, additions, deletions, rows: buildRows(lines) };
}

// ─── Per-file gutter markers (existing API) ────────────────────────

export interface DiffLineMarker {
  /** 1-based line number in the NEW (post-diff) file. */
  line: number;
  /** "added" = this line was inserted; "removed-after" = deletions preceded this line. */
  kind: "added" | "removed-after";
  /** For "removed-after": number of consecutive lines that were deleted. */
  count?: number;
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
      // Flush deletions trailing the PREVIOUS hunk before resetting position,
      // otherwise a non-final hunk ending in removals loses its gutter marker.
      if (pendingRemovals > 0) {
        markers.push({ line: newLine + 1, kind: "removed-after", count: pendingRemovals });
      }
      newLine = parseInt(hunkMatch[1], 10) - 1; // will be incremented on first context/+ line
      pendingRemovals = 0;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue; // still in the file header before the first hunk

    if (line.startsWith("+") && !line.startsWith("+++")) {
      // Flush any pending removals: they happened just before this new line.
      if (pendingRemovals > 0) {
        markers.push({ line: newLine + 1, kind: "removed-after", count: pendingRemovals });
        pendingRemovals = 0;
      }
      newLine++;
      markers.push({ line: newLine, kind: "added" });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      pendingRemovals++;
    } else if (!line.startsWith("\\")) {
      // Context line (or blank): flush pending removals first.
      if (pendingRemovals > 0) {
        markers.push({ line: newLine + 1, kind: "removed-after", count: pendingRemovals });
        pendingRemovals = 0;
      }
      newLine++;
    }
  }

  // Flush any removals at the end of a hunk.
  if (pendingRemovals > 0) {
    markers.push({ line: newLine + 1, kind: "removed-after", count: pendingRemovals });
  }

  return markers;
}
