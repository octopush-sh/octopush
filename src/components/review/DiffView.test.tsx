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
  describe("viewed marks", () => {
    const hunk = (text: string, header = "@@ -1 +1 @@") => ({
      header, lines: [], rawText: "x", additions: 1, deletions: 0,
      rows: [{ kind: "add" as const, text, oldLine: null, newLine: 1 }],
    });
    const file = (path: string, ...texts: string[]): DiffFile => ({
      filePath: path, changeType: "modified", fileHeader: "", hunks: texts.map((t) => hunk(t)),
    });
    const view = (fs: DiffFile[], ws = "/w", onViewedChange = vi.fn()) => (
      <DiffView files={fs} workspacePath={ws} onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} onViewedChange={onViewedChange} />
    );
    const section = (c: HTMLElement, path: string) =>
      c.querySelector(`[id="review-file-${encodeURIComponent(path)}"]`) as HTMLElement;
    const collapsedOf = (c: HTMLElement, path: string) =>
      section(c, path).querySelector("[data-collapsed]")!.getAttribute("data-collapsed");

    it("drops the mark, expands the file and shows the chip when its hunks change", () => {
      const onViewedChange = vi.fn();
      const { container, getByText, queryByText, rerender } = render(view([file("src/a.ts", "one")], "/w", onViewedChange));
      fireEvent.click(getByText("mark viewed"));
      expect(getByText("✓ viewed")).toBeTruthy();
      expect(collapsedOf(container, "src/a.ts")).toBe("true");

      rerender(view([file("src/a.ts", "one", "two")], "/w", onViewedChange));
      expect(queryByText("✓ viewed")).toBeNull();
      expect(getByText("mark viewed")).toBeTruthy();
      expect(collapsedOf(container, "src/a.ts")).toBe("false");
      expect(getByText("changed since viewed").getAttribute("title")).toBe(
        "This file changed after you marked it viewed",
      );
      expect(onViewedChange).toHaveBeenLastCalledWith("src/a.ts", false);

      // Re-marking clears the chip.
      fireEvent.click(getByText("mark viewed"));
      expect(queryByText("changed since viewed")).toBeNull();
      expect(getByText("✓ viewed")).toBeTruthy();
    });

    it("keeps marks on unchanged files across a refetch, and after a hunk leaves", () => {
      const { container, getAllByText, queryByText, rerender } = render(
        view([file("src/a.ts", "one", "two"), file("src/b.ts", "b")]),
      );
      fireEvent.click(getAllByText("mark viewed")[0]);
      // A fresh array with the same content, then the same file minus an accepted hunk
      // (its header shifted) — neither is a new change.
      rerender(view([file("src/a.ts", "one", "two"), file("src/b.ts", "b", "b2")]));
      rerender(view([
        { ...file("src/a.ts"), hunks: [hunk("two", "@@ -3 +3 @@")] },
        file("src/b.ts", "b", "b2"),
      ]));
      expect(section(container, "src/a.ts").textContent).toContain("✓ viewed");
      expect(collapsedOf(container, "src/a.ts")).toBe("true");
      expect(queryByText("changed since viewed")).toBeNull();
    });

    it("resets marks when the workspace changes", () => {
      const fs = [file("src/a.ts", "one")];
      const { getByText, queryByText, rerender } = render(view(fs, "/w1"));
      fireEvent.click(getByText("mark viewed"));
      rerender(view(fs, "/w2"));
      expect(queryByText("✓ viewed")).toBeNull();
      expect(queryByText("changed since viewed")).toBeNull();
    });
  });
  it("renders empty state with no files", () => {
    const { getByText } = render(<DiffView files={[]} stagedCount={2} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText(/staged/i)).toBeTruthy();
  });
});
