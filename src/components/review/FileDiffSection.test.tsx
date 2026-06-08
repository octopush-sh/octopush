import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FileDiffSection } from "./FileDiffSection";
import type { DiffFile } from "../../lib/diffParser";

const file: DiffFile = {
  filePath: "src/a.ts", changeType: "modified", fileHeader: "",
  hunks: [{ header: "@@ -1,1 +1,1 @@", lines: ["@@ -1,1 +1,1 @@","-a","+b"], rawText: "x", additions: 1, deletions: 1,
    rows: [{ kind: "del", text: "a", oldLine: 1, newLine: null }, { kind: "add", text: "b", oldLine: null, newLine: 1 }] }],
};

describe("FileDiffSection", () => {
  it("shows the file header with type + path", () => {
    const { getByText } = render(<FileDiffSection file={file} focusedHunk={-1} viewed={false} collapsed={false}
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    expect(getByText("MODIFIED")).toBeTruthy();
    expect(getByText("src/a.ts")).toBeTruthy();
  });
  it("collapses content when collapsed", () => {
    const { container } = render(<FileDiffSection file={file} focusedHunk={-1} viewed collapsed
      onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} onToggleViewed={()=>{}} onToggleCollapsed={()=>{}} />);
    // grid-rows 0fr collapse: the content wrapper has grid-template-rows 0fr — assert the collapse container exists with the collapsed style
    expect(container.querySelector('[data-collapsed="true"]')).toBeTruthy();
  });
});
