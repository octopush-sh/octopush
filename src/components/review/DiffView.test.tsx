import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { DiffFile } from "../../lib/diffParser";

const files: DiffFile[] = [{
  filePath: "src/a.ts", changeType: "modified", fileHeader: "",
  hunks: [{ header: "@@ -1 +1 @@", lines: [], rawText: "x", additions: 1, deletions: 0,
    rows: [{ kind: "add", text: "b", oldLine: null, newLine: 1 }] }],
}];

describe("DiffView", () => {
  it("pressing o opens the focused hunk's file at its first changed new-file line", () => {
    const withContext: DiffFile[] = [{
      filePath: "src/a.ts", changeType: "modified", fileHeader: "",
      hunks: [{ header: "@@ -4,2 +4,3 @@", lines: [], rawText: "x", additions: 1, deletions: 0,
        rows: [
          { kind: "context", text: "a", oldLine: 4, newLine: 4 },
          { kind: "add", text: "b", oldLine: null, newLine: 5 },
        ] }],
    }];
    const onOpen = vi.fn();
    render(<DiffView files={withContext} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={onOpen} />);
    fireEvent.keyDown(window, { key: "o" });
    expect(onOpen).toHaveBeenCalledWith("src/a.ts", 5);
  });
  it("renders a section per file", () => {
    const { getByText } = render(<DiffView files={files} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText("src/a.ts")).toBeTruthy();
  });
  it("renders empty state with no files", () => {
    const { getByText } = render(<DiffView files={[]} stagedCount={2} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText(/staged/i)).toBeTruthy();
  });
});
