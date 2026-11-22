import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommentableDocument, rangeAt, textOffset } from "./CommentableDocument";

/** Select `passage` inside `root` the way a drag would, and release. */
function selectPassage(root: HTMLElement, passage: string) {
  const at = root.textContent!.indexOf(passage);
  const range = rangeAt(root, at, passage.length)!;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.mouseUp(root);
}

const DOC = "# The plan\n\n1. Add the column\n2. Drop the old table\n3. Ship it";

describe("CommentableDocument", () => {
  it("maps rendered-text offsets to ranges and back", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Hello <b>brave</b> world</p>";
    const r = rangeAt(root, 6, 11)!;
    expect(r.toString()).toBe("brave world");
    expect(textOffset(root, r.startContainer, r.startOffset)).toBe(6);
    expect(rangeAt(root, 6, 100)).toBeNull();
  });

  it("selecting a passage opens the composer; adding sends the quote, note and position", () => {
    const onAdd = vi.fn();
    render(<CommentableDocument text={DOC} comments={[]} onAdd={onAdd} onRemove={vi.fn()} tour={{ document: "doc" }} />);
    expect(screen.getByText("Select a passage to comment on it.")).toBeInTheDocument();
    const root = document.querySelector('[data-tour="doc"]') as HTMLElement;
    selectPassage(root, "Drop the old table");
    const box = screen.getByRole("textbox", { name: "Your comment on this passage" });
    expect(screen.getByRole("button", { name: "Add the comment" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "Keep the data." } });
    fireEvent.click(screen.getByRole("button", { name: "Add the comment" }));
    const at = root.textContent!.indexOf("Drop the old table");
    expect(onAdd).toHaveBeenCalledWith("Drop the old table", "Keep the data.", at, "Drop the old table".length);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("ignores a selection outside the document, and Escape cancels the composer", () => {
    render(
      <>
        <p>elsewhere text</p>
        <CommentableDocument text={DOC} comments={[]} onAdd={vi.fn()} onRemove={vi.fn()} tour={{ document: "doc" }} />
      </>,
    );
    const outside = screen.getByText("elsewhere text");
    const r = document.createRange();
    r.selectNodeContents(outside);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    fireEvent.mouseUp(document.querySelector('[data-tour="doc"]')!);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    selectPassage(document.querySelector('[data-tour="doc"]') as HTMLElement, "Ship it");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("lists the comments in document order and removes one", () => {
    const onRemove = vi.fn();
    render(
      <CommentableDocument
        text={DOC}
        comments={[
          { id: "b", quote: "Ship it", note: "After the freeze.", at: 50, len: 7 },
          { id: "a", quote: "Add the column", note: "Nullable first.", at: 10, len: 14 },
        ]}
        onAdd={vi.fn()}
        onRemove={onRemove}
        tour={{ list: "list" }}
      />,
    );
    const list = document.querySelector('[data-tour="list"]')!;
    expect(list.textContent).toMatch(/your comments · 2/i);
    expect(list.textContent!.indexOf("Nullable first.")).toBeLessThan(list.textContent!.indexOf("After the freeze."));
    expect(screen.queryByText("Select a passage to comment on it.")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove this comment" })[0]);
    expect(onRemove).toHaveBeenCalledWith("a");
  });
});
