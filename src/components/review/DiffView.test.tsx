import { describe, it, expect, vi, beforeEach } from "vitest";

const { pushToastMock } = vi.hoisted(() => ({ pushToastMock: vi.fn() }));
vi.mock("../Toasts", () => ({ pushToast: pushToastMock }));
import { render, fireEvent } from "@testing-library/react";
import { DiffView, keyboardHelpLine } from "./DiffView";
import { useReviewComments } from "../../stores/reviewCommentsStore";
import type { DiffFile } from "../../lib/diffParser";

const files: DiffFile[] = [{
  filePath: "src/a.ts", changeType: "modified", fileHeader: "",
  hunks: [{ header: "@@ -1 +1 @@", lines: [], rawText: "x", additions: 1, deletions: 0,
    rows: [{ kind: "add", text: "b", oldLine: null, newLine: 1 }] }],
}];

describe("DiffView", () => {
  it("leaves the accept / reject keys out of the ? help in the read-only view (#903)", () => {
    expect(keyboardHelpLine(false)).toContain("a accept · x reject · A file");
    expect(keyboardHelpLine(true)).not.toMatch(/\ba accept|x reject|A file/);
    const { getByRole } = render(
      <DiffView files={files} readOnly workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />,
    );
    fireEvent.keyDown(window, { key: "?" });
    const help = getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(help.textContent).not.toContain("accept");
    expect(help.textContent).toContain("w why");
  });
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
  describe("ask for a change (#956)", () => {
    const two: DiffFile[] = [{
      filePath: "src/a.ts", changeType: "modified", fileHeader: "",
      hunks: [{ header: "@@ -4,2 +4,3 @@", lines: [], rawText: "x", additions: 2, deletions: 0,
        rows: [
          { kind: "context", text: "a", oldLine: 4, newLine: 4 },
          { kind: "add", text: "b", oldLine: null, newLine: 5 },
          { kind: "add", text: "c", oldLine: null, newLine: 6 },
        ] }],
    }];
    const view = (fs: DiffFile[], readOnly = false, ws = "w1") => (
      <DiffView files={fs} workspacePath={`/${ws}`} workspaceId={ws} readOnly={readOnly} onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />
    );
    beforeEach(() => useReviewComments.setState({ byWs: {}, liveByWs: {}, draftByWs: {} }));

    it("⌥↓ / ⌥↑ in the field pick a line, and with ⇧ extend the range (#1051)", () => {
      const { getByLabelText, getByText, container } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      const field = getByLabelText("What should change");
      fireEvent.change(field, { target: { value: "Half a tho" } });
      fireEvent.keyDown(field, { key: "ArrowDown", altKey: true });
      expect(getByText("src/a.ts:4")).toBeTruthy();
      fireEvent.keyDown(field, { key: "ArrowDown", altKey: true });
      expect(getByText("src/a.ts:5")).toBeTruthy();
      fireEvent.keyDown(field, { key: "ArrowDown", altKey: true, shiftKey: true });
      expect(getByText("src/a.ts:5–6")).toBeTruthy();
      expect(container.querySelectorAll("[data-picked]")).toHaveLength(2);
      // The field keeps the focus and the note; ⌘⏎ adds the picked lines.
      expect(document.activeElement).toBe(field);
      fireEvent.keyDown(field, { key: "Enter", metaKey: true });
      expect(useReviewComments.getState().byWs.w1).toEqual([
        expect.objectContaining({ startLine: 5, endLine: 6, quote: ["+b", "+c"], note: "Half a tho" }),
      ]);
    });

    it("a plain arrow in the field stays the field's", () => {
      const { getByLabelText, getByText } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      const field = getByLabelText("What should change");
      expect(fireEvent.keyDown(field, { key: "ArrowDown" })).toBe(true);
      expect(getByText("src/a.ts:4–6")).toBeTruthy();
    });

    it("keeps a half-typed note in its workspace while the view shows another (#1051)", () => {
      const { getByLabelText, queryByLabelText, rerender } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      fireEvent.change(getByLabelText("What should change"), { target: { value: "Half a tho" } });
      rerender(view(two, false, "w2"));
      expect(queryByLabelText("What should change")).toBeNull();
      expect(useReviewComments.getState().byWs.w2 ?? []).toEqual([]);
      rerender(view(two, false, "w1"));
      expect((getByLabelText("What should change") as HTMLTextAreaElement).value).toBe("Half a tho");
      expect(useReviewComments.getState().byWs.w1 ?? []).toEqual([]);
    });

    it("m opens a comment on the focused hunk; ⌘⏎ adds it to the tray and shows it under the hunk", () => {
      const { getByLabelText, getByText } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      const field = getByLabelText("What should change");
      expect(getByText("src/a.ts:4–6")).toBeTruthy();
      fireEvent.change(field, { target: { value: "Split this." } });
      fireEvent.keyDown(field, { key: "Enter", metaKey: true });
      const [c] = useReviewComments.getState().byWs.w1;
      expect(c).toMatchObject({ filePath: "src/a.ts", startLine: 4, endLine: 6, note: "Split this.", quote: [" a", "+b", "+c"] });
      expect(getByText("Split this.")).toBeTruthy();
      expect(useReviewComments.getState().liveByWs.w1.size).toBe(1);
    });

    it("a line number starts a comment on that line; shift-click extends it", () => {
      const { getByText, getAllByText, getByRole, container } = render(view(two));
      fireEvent.click(getAllByText("5")[0]);
      expect(getByText("src/a.ts:5")).toBeTruthy();
      fireEvent.click(getAllByText("6")[0], { shiftKey: true });
      expect(getByText("src/a.ts:5–6")).toBeTruthy();
      expect(container.querySelectorAll("[data-picked]")).toHaveLength(2);
      fireEvent.click(getByRole("button", { name: "Cancel" }));
      expect(container.querySelectorAll("[data-picked]")).toHaveLength(0);
    });

    it("Escape in the composer drops the draft and doesn't reach the diff keyboard", () => {
      const seen: string[] = [];
      const onKey = (e: KeyboardEvent) => seen.push(e.key);
      const { getByLabelText, queryByLabelText, container } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      const field = getByLabelText("What should change");
      fireEvent.change(field, { target: { value: "Never mind." } });
      window.addEventListener("keydown", onKey);
      try {
        fireEvent.keyDown(field, { key: "Escape" });
      } finally {
        window.removeEventListener("keydown", onKey);
      }
      expect(seen).toEqual([]);
      expect(queryByLabelText("What should change")).toBeNull();
      expect(container.querySelectorAll("[data-picked]")).toHaveLength(0);
      expect(useReviewComments.getState().byWs.w1 ?? []).toEqual([]);
    });

    it("names the shortcut with the app's ⌘⏎ glyph", () => {
      const { getByRole } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      expect(getByRole("button", { name: "Ask for this change" }).getAttribute("title")).toBe("Add to the comments for the agent (⌘⏎)");
    });

    it("keeps the typed note when another line is picked, in this hunk or another", () => {
      const twoHunks: DiffFile[] = [{ ...two[0], hunks: [two[0].hunks[0], {
        header: "@@ -20 +21 @@", lines: [], rawText: "y", additions: 1, deletions: 0,
        rows: [{ kind: "add", text: "z", oldLine: null, newLine: 21 }],
      }] }];
      const { getByLabelText, getByText, getAllByText } = render(view(twoHunks));
      fireEvent.click(getAllByText("5")[0]);
      fireEvent.change(getByLabelText("What should change"), { target: { value: "Half a tho" } });
      fireEvent.click(getAllByText("6")[0]);
      expect(getByText("src/a.ts:6")).toBeTruthy();
      expect((getByLabelText("What should change") as HTMLTextAreaElement).value).toBe("Half a tho");
      fireEvent.click(getAllByText("21")[0]);
      expect(getByText("src/a.ts:21")).toBeTruthy();
      const field = getByLabelText("What should change") as HTMLTextAreaElement;
      expect(field.value).toBe("Half a tho");
      // The moved field has the focus, so the next key is typed, not a diff key.
      expect(document.activeElement).toBe(field);
    });

    it("keeps the field open, as outdated, when a refetch changes the hunk under a typed note", () => {
      const { getByLabelText, rerender, container } = render(view(two));
      fireEvent.click(container.querySelectorAll("[data-diff-row]")[1].querySelectorAll("span")[1]);
      fireEvent.change(getByLabelText("What should change"), { target: { value: "Half a tho" } });
      const edited: DiffFile[] = [{ ...two[0], hunks: [{ ...two[0].hunks[0], rawText: "changed",
        rows: [...two[0].hunks[0].rows, { kind: "add", text: "d", oldLine: null, newLine: 7 }] }] }];
      rerender(view(edited));
      const field = getByLabelText("What should change") as HTMLTextAreaElement;
      expect(field.value).toBe("Half a tho");
      expect(container.querySelector("[data-comment-stale]")).toBeTruthy();
      fireEvent.keyDown(field, { key: "Enter", metaKey: true });
      // Added with the place and lines it was written on: the tray shows it outdated.
      const [c] = useReviewComments.getState().byWs.w1;
      expect(c).toMatchObject({ startLine: 5, endLine: 5, quote: ["+b"], note: "Half a tho" });
      expect(useReviewComments.getState().liveByWs.w1.has(`src/a.ts\n${c.fingerprint}`)).toBe(false);
    });

    it("keeps a typed note in the tray when its file leaves the diff", () => {
      pushToastMock.mockClear();
      const { getByLabelText, queryByLabelText, rerender } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      fireEvent.change(getByLabelText("What should change"), { target: { value: "Half a tho" } });
      const elsewhere: DiffFile[] = [{ ...two[0], filePath: "src/b.ts" }];
      rerender(view(elsewhere));
      expect(queryByLabelText("What should change")).toBeNull();
      expect(useReviewComments.getState().byWs.w1).toEqual([expect.objectContaining({ filePath: "src/a.ts", note: "Half a tho" })]);
      expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Your comment was kept" }));
    });

    it("an empty draft whose file left the diff just closes", () => {
      pushToastMock.mockClear();
      const { rerender, queryByLabelText } = render(view(two));
      fireEvent.keyDown(window, { key: "m" });
      rerender(view([{ ...two[0], filePath: "src/b.ts" }]));
      expect(queryByLabelText("What should change")).toBeNull();
      expect(useReviewComments.getState().byWs.w1 ?? []).toEqual([]);
      expect(pushToastMock).not.toHaveBeenCalled();
    });

    it("m on a folded file opens it to show the field, and folding again keeps the note", () => {
      const { getByLabelText, queryByLabelText, container } = render(view(two));
      const folded = () => container.querySelector("[data-collapsed]")!.getAttribute("data-collapsed");
      fireEvent.keyDown(window, { key: " " });
      expect(folded()).toBe("true");
      fireEvent.keyDown(window, { key: "m" });
      expect(folded()).toBe("false");
      fireEvent.change(getByLabelText("What should change"), { target: { value: "Half a tho" } });
      (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(window, { key: " " });
      fireEvent.keyDown(window, { key: " " });
      expect(folded()).toBe("false");
      expect((queryByLabelText("What should change") as HTMLTextAreaElement | null)?.value).toBe("Half a tho");
    });

    it("offers no comments in the read-only Since base view", () => {
      const { queryByRole, queryByLabelText } = render(view(two, true));
      expect(queryByRole("button", { name: "Ask for a change" })).toBeNull();
      // `m` is left alone there, not claimed and swallowed.
      expect(fireEvent.keyDown(window, { key: "m" })).toBe(true);
      expect(queryByLabelText("What should change")).toBeNull();
      expect(keyboardHelpLine(true)).not.toContain("m ask");
      expect(keyboardHelpLine(false)).toContain("m ask for a change");
    });
  });
  it("renders empty state with no files", () => {
    const { getByText } = render(<DiffView files={[]} stagedCount={2} workspacePath="/w" onAccept={vi.fn()} onReject={vi.fn()} onWhy={vi.fn()} onOpen={vi.fn()} />);
    expect(getByText(/staged/i)).toBeTruthy();
  });
});
