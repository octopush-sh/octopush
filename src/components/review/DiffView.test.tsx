import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { DiffView } from "./DiffView";
import type { DiffFile } from "../../lib/diffParser";

const files: DiffFile[] = [{
  filePath: "src/a.ts", changeType: "modified", fileHeader: "",
  hunks: [{ header: "@@ -1 +1 @@", lines: [], rawText: "x", additions: 1, deletions: 0,
    rows: [{ kind: "add", text: "b", oldLine: null, newLine: 1 }] }],
}];

describe("DiffView", () => {
  it("renders a section per file", () => {
    const { getByText } = render(<DiffView files={files} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText("src/a.ts")).toBeTruthy();
  });
  it("renders empty state with no files", () => {
    const { getByText } = render(<DiffView files={[]} stagedCount={2} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText(/staged/i)).toBeTruthy();
  });
});
