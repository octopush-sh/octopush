import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CommentableDocument, rangeAt, textOffset } from "./CommentableDocument";

/** Select `passage` inside `root` the way a drag (or Shift+arrows) would. */
function selectPassage(root: HTMLElement, passage: string) {
  const at = root.textContent!.indexOf(passage);
  const range = rangeAt(root, at, passage.length)!;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => { document.dispatchEvent(new Event("selectionchange")); });
}
const offer = () => document.querySelector("[data-comment-offer]") as HTMLButtonElement | null;
/** Select a passage and use the *Comment* affordance next to it. */
function commentOn(root: HTMLElement, passage: string) {
  selectPassage(root, passage);
  fireEvent.click(offer()!);
}
const docRoot = () => document.querySelector('[data-tour="doc"]') as HTMLElement;
const noteBox = () => screen.getByRole("textbox", { name: "Your comment on this passage" }) as HTMLTextAreaElement;

const DOC = "# The plan\n\n1. Add the column\n2. Drop the old table\n3. Ship it";
const doc = (over: Partial<Parameters<typeof CommentableDocument>[0]> = {}) => (
  <CommentableDocument text={DOC} comments={[]} onAdd={vi.fn()} onRemove={vi.fn()} tour={{ document: "doc", list: "list" }} {...over} />
);

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  delete (globalThis as any).Highlight;
  delete (globalThis as any).CSS;
});

describe("CommentableDocument", () => {
  it("maps rendered-text offsets to ranges and back", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Hello <b>brave</b> world</p>";
    const r = rangeAt(root, 6, 11)!;
    expect(r.toString()).toBe("brave world");
    expect(textOffset(root, r.startContainer, r.startOffset)).toBe(6);
    expect(rangeAt(root, 6, 100)).toBeNull();
  });

  it("a selection stays a selection: it only brings up Comment, and copying works as before", () => {
    render(doc());
    expect(screen.getByText("Select a passage, then Comment. From the keyboard: ↑ ↓ and ⏎.")).toBeInTheDocument();
    selectPassage(docRoot(), "Drop the old table");
    // No composer, no focus taken, the selection untouched: ⌘C copies it.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(window.getSelection()!.toString()).toBe("Drop the old table");
    expect(document.activeElement?.tagName).not.toBe("TEXTAREA");
    expect(offer()).toHaveAttribute("title", "Comment on this passage");
    // Pressing the affordance must not collapse the selection either.
    expect(fireEvent.mouseDown(offer()!)).toBe(false);
    // Releasing the mouse over the document opens nothing.
    fireEvent.mouseUp(docRoot());
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // The selection going away takes the affordance with it.
    window.getSelection()!.removeAllRanges();
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
    expect(offer()).toBeNull();
  });

  it("Comment opens the composer on the selected passage; adding sends the quote, note and position", () => {
    const onAdd = vi.fn();
    render(doc({ onAdd }));
    commentOn(docRoot(), "Drop the old table");
    expect(document.activeElement).toBe(noteBox());
    expect(screen.getByRole("button", { name: "Add the comment" })).toBeDisabled();
    fireEvent.change(noteBox(), { target: { value: "Keep the data." } });
    fireEvent.click(screen.getByRole("button", { name: "Add the comment" }));
    const at = docRoot().textContent!.indexOf("Drop the old table");
    expect(onAdd).toHaveBeenCalledWith("Drop the old table", "Keep the data.", at, "Drop the old table".length);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("does not rebuild the document when a note is typed or the parent renders again", () => {
    const { rerender } = render(doc());
    const item = docRoot().querySelectorAll("li")[1];
    const textNode = item.firstChild;
    commentOn(docRoot(), "Drop the old table");
    fireEvent.change(noteBox(), { target: { value: "K" } });
    fireEvent.change(noteBox(), { target: { value: "Ke" } });
    rerender(doc({ comments: [{ id: "a", quote: "Ship it", note: "Later.", at: 44, len: 7 }] }));
    expect(docRoot().querySelectorAll("li")[1]).toBe(item);
    expect(item.firstChild).toBe(textNode);
    expect(item.isConnected).toBe(true);
  });

  it("keeps the marks on the rendered text through renders and a new text", () => {
    const set = vi.fn();
    (globalThis as any).CSS = { highlights: { set, delete: vi.fn() } };
    (globalThis as any).Highlight = class { ranges: Range[]; constructor(...r: Range[]) { this.ranges = r; } };
    const marked = () => (set.mock.calls.at(-1)![1] as { ranges: Range[] }).ranges;
    const at = (t: string) => docRoot().textContent!.indexOf(t);
    const { rerender } = render(doc());
    const comments = [{ id: "a", quote: "Ship it", note: "Later.", at: at("Ship it"), len: 7 }];
    rerender(doc({ comments }));
    expect(marked().map(String)).toEqual(["Ship it"]);
    commentOn(docRoot(), "Add the column");
    fireEvent.change(noteBox(), { target: { value: "Nullable first." } });
    // The commented passage and the one being commented on, on nodes still in the page.
    expect(marked().map(String)).toEqual(["Ship it", "Add the column"]);
    expect(marked().every((r) => r.startContainer.isConnected)).toBe(true);
    // A new text lays them again on the new nodes.
    rerender(doc({ comments, text: `Intro.\n\n${DOC}` }));
    expect(marked().every((r) => r.startContainer.isConnected)).toBe(true);
  });

  it("keeps a typed note when another passage is selected; Comment points the note at it", () => {
    const onAdd = vi.fn();
    render(doc({ onAdd }));
    commentOn(docRoot(), "Ship it");
    fireEvent.change(noteBox(), { target: { value: "After the freeze." } });
    selectPassage(docRoot(), "Add the column");
    // Selecting alone changes nothing in the composer.
    expect(noteBox().value).toBe("After the freeze.");
    expect(noteBox().closest("div")!.textContent).toContain("Ship it");
    fireEvent.click(offer()!);
    expect(noteBox().value).toBe("After the freeze.");
    expect(document.activeElement).toBe(noteBox());
    fireEvent.keyDown(noteBox(), { key: "Enter", metaKey: true });
    expect(onAdd).toHaveBeenCalledWith("Add the column", "After the freeze.", docRoot().textContent!.indexOf("Add the column"), "Add the column".length);
  });

  it("has a keyboard path: the document takes focus, arrows move over its passages, Enter comments on one", () => {
    const onAdd = vi.fn();
    render(doc({ onAdd }));
    const root = docRoot();
    expect(root).toHaveAttribute("tabindex", "0");
    root.focus();
    const cursor = () => root.querySelector("[data-comment-cursor]");
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(cursor()?.textContent).toBe("The plan");
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(cursor()?.textContent).toBe("Drop the old table");
    // Shift+arrows extend a selection and are left to the engine.
    expect(fireEvent.keyDown(root, { key: "ArrowDown", shiftKey: true })).toBe(true);
    expect(cursor()?.textContent).toBe("Drop the old table");
    fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(cursor()?.textContent).toBe("Add the column");
    expect(offer()).not.toBeNull();
    fireEvent.keyDown(root, { key: "Enter" });
    expect(cursor()).toBeNull();
    expect(document.activeElement).toBe(noteBox());
    fireEvent.change(noteBox(), { target: { value: "Nullable first." } });
    fireEvent.keyDown(noteBox(), { key: "Enter", ctrlKey: true });
    expect(onAdd).toHaveBeenCalledWith("Add the column", "Nullable first.", root.textContent!.indexOf("Add the column"), "Add the column".length);
  });

  it("the keyboard cursor stops at the ends, and Escape or leaving the document puts it away", () => {
    render(doc());
    const root = docRoot();
    const cursor = () => root.querySelector("[data-comment-cursor]");
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(cursor()?.textContent).toBe("The plan");
    for (let i = 0; i < 9; i++) fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(cursor()?.textContent).toBe("Ship it");
    fireEvent.keyDown(root, { key: "Escape" });
    expect(cursor()).toBeNull();
    expect(offer()).toBeNull();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.blur(root);
    expect(cursor()).toBeNull();
    // Enter with nothing marked does nothing.
    fireEvent.keyDown(root, { key: "Enter" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("⌘⏎ and Ctrl+⏎ add the comment, and do nothing while the note is empty", () => {
    const onAdd = vi.fn();
    render(doc({ onAdd }));
    commentOn(docRoot(), "Ship it");
    fireEvent.keyDown(noteBox(), { key: "Enter", metaKey: true });
    fireEvent.change(noteBox(), { target: { value: "   " } });
    fireEvent.keyDown(noteBox(), { key: "Enter", ctrlKey: true });
    expect(onAdd).not.toHaveBeenCalled();
    // A plain Enter is a line break, not an add.
    fireEvent.change(noteBox(), { target: { value: "After the freeze." } });
    fireEvent.keyDown(noteBox(), { key: "Enter" });
    expect(onAdd).not.toHaveBeenCalled();
    fireEvent.keyDown(noteBox(), { key: "Enter", metaKey: true });
    expect(onAdd).toHaveBeenCalledWith("Ship it", "After the freeze.", docRoot().textContent!.indexOf("Ship it"), "Ship it".length);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("ignores a selection outside the document, and Escape cancels the composer", () => {
    render(<><p>elsewhere text</p>{doc()}</>);
    const r = document.createRange();
    r.selectNodeContents(screen.getByText("elsewhere text"));
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
    expect(offer()).toBeNull();

    commentOn(docRoot(), "Ship it");
    fireEvent.keyDown(noteBox(), { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("Cancel wears the strong border the other comment fields use", () => {
    render(doc());
    commentOn(docRoot(), "Ship it");
    expect(screen.getByRole("button", { name: "Cancel" }).className).toContain("border-octo-border-strong");
  });

  it("lists the comments in document order and removes one", () => {
    const onRemove = vi.fn();
    render(doc({
      onRemove,
      comments: [
        { id: "b", quote: "Ship it", note: "After the freeze.", at: 50, len: 7 },
        { id: "a", quote: "Add the column", note: "Nullable first.", at: 10, len: 14 },
      ],
    }));
    const list = document.querySelector('[data-tour="list"]')!;
    expect(list.textContent).toMatch(/your comments · 2/i);
    expect(list.textContent!.indexOf("Nullable first.")).toBeLessThan(list.textContent!.indexOf("After the freeze."));
    expect(screen.queryByText(/Select a passage, then Comment/)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove this comment" })[0]);
    expect(onRemove).toHaveBeenCalledWith("a");
  });
});
