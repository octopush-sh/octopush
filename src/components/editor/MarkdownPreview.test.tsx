import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders headings, lists, and inline emphasis", () => {
    render(<MarkdownPreview source={"# Title\n\nHello **bold** world\n\n- one\n- two"} />);
    expect(screen.getByRole("heading", { level: 1, name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("renders a GFM table (remark-gfm enabled)", () => {
    const src = "| A | B |\n| - | - |\n| 1 | 2 |";
    render(<MarkdownPreview source={src} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "A" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "1" })).toBeInTheDocument();
  });

  it("renders GFM task-list checkboxes", () => {
    render(<MarkdownPreview source={"- [x] done\n- [ ] todo"} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it("does NOT execute raw HTML — it renders inert as text", () => {
    render(<MarkdownPreview source={"<script>window.__x=1</script>\n\n<b>nothonored</b>"} />);
    // No live <script>/<b> element is created from the source HTML.
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByText("nothonored", { selector: "b" })).toBeNull();
    // The literal characters survive as visible text.
    expect(screen.getByText(/nothonored<\/b>|<b>nothonored<\/b>/)).toBeInTheDocument();
  });

  it("renders an UNLABELED fenced code block as a block, not an inline pill", () => {
    const { container } = render(<MarkdownPreview source={"```\nline one\nline two\n```"} />);
    const code = container.querySelector("pre code");
    expect(code).not.toBeNull();
    // Block branch styling (bordered, padded box) — not the inline pill.
    expect(code!.className).toContain("border-octo-hairline");
    expect(code!.className).not.toContain("px-1.5");
  });
});

// ─── Jump to source + selectable prose ──────────────────────────────

const DOC = [
  "# Title",
  "",
  "A paragraph of prose.",
  "",
  "- first item",
  "- second item",
  "",
  "> a quote",
].join("\n");

const marker = () => screen.queryByRole("button", { name: /jump to line/i });

describe("MarkdownPreview — jump to source", () => {
  it("stamps every block with the source line that produced it", () => {
    const { container } = render(<MarkdownPreview source={DOC} />);
    expect(container.querySelector("h1")).toHaveAttribute("data-md-line", "1");
    expect(container.querySelector("p")).toHaveAttribute("data-md-line", "3");
    expect(container.querySelector("ul")).toHaveAttribute("data-md-line", "5");
    const items = container.querySelectorAll("li");
    expect(items[0]).toHaveAttribute("data-md-line", "5");
    expect(items[1]).toHaveAttribute("data-md-line", "6");
    expect(container.querySelector("blockquote")).toHaveAttribute("data-md-line", "8");
  });

  // The app sets `user-select: none` on <body>; the preview has to opt back in
  // or rendered prose can't be selected and copied at all.
  it("opts the rendered prose into text selection", () => {
    render(<MarkdownPreview source={DOC} />);
    expect(screen.getByTestId("markdown-preview").className).toContain("octo-selectable");
  });

  it("shows no jump affordance when no jump handler is given", () => {
    render(<MarkdownPreview source={DOC} />);
    fireEvent.mouseOver(screen.getByText("A paragraph of prose."));
    expect(marker()).toBeNull();
  });

  it("hovering a block reveals its line marker; clicking it jumps", () => {
    const onJumpToLine = vi.fn();
    render(<MarkdownPreview source={DOC} onJumpToLine={onJumpToLine} />);

    fireEvent.mouseOver(screen.getByText("A paragraph of prose."));
    const btn = marker();
    expect(btn).toHaveTextContent("3");

    fireEvent.click(btn!);
    expect(onJumpToLine).toHaveBeenCalledWith(3);
  });

  // The innermost stamped element wins, so a list item beats its list.
  it("resolves the line of the innermost block under the pointer", () => {
    render(<MarkdownPreview source={DOC} onJumpToLine={vi.fn()} />);
    fireEvent.mouseOver(screen.getByText("second item"));
    expect(marker()).toHaveTextContent("6");
  });

  it("keeps the marker mounted but inert once the pointer leaves", () => {
    render(<MarkdownPreview source={DOC} onJumpToLine={vi.fn()} />);
    fireEvent.mouseOver(screen.getByText("A paragraph of prose."));
    expect(marker()?.className).toContain("opacity-100");
    fireEvent.mouseLeave(screen.getByTestId("markdown-preview"));
    expect(marker()?.className).toContain("opacity-0");
    expect(marker()?.className).toContain("pointer-events-none");
  });

  it("⌘-click on a block jumps to its line", () => {
    const onJumpToLine = vi.fn();
    render(<MarkdownPreview source={DOC} onJumpToLine={onJumpToLine} />);
    fireEvent.click(screen.getByText("A paragraph of prose."), { metaKey: true });
    expect(onJumpToLine).toHaveBeenCalledWith(3);
  });

  it("Ctrl-click on a block jumps to its line", () => {
    const onJumpToLine = vi.fn();
    render(<MarkdownPreview source={DOC} onJumpToLine={onJumpToLine} />);
    fireEvent.click(screen.getByText("first item"), { ctrlKey: true });
    expect(onJumpToLine).toHaveBeenCalledWith(5);
  });

  // An unmodified click must stay ordinary — that is what leaves drag-selection
  // and links working, which is the point of a copyable preview.
  it("leaves an unmodified click alone", () => {
    const onJumpToLine = vi.fn();
    render(<MarkdownPreview source={DOC} onJumpToLine={onJumpToLine} />);
    fireEvent.click(screen.getByText("A paragraph of prose."));
    expect(onJumpToLine).not.toHaveBeenCalled();
  });

  it("ignores a ⌘-click that lands outside any block", () => {
    const onJumpToLine = vi.fn();
    render(<MarkdownPreview source={DOC} onJumpToLine={onJumpToLine} />);
    fireEvent.click(screen.getByTestId("markdown-preview"), { metaKey: true });
    expect(onJumpToLine).not.toHaveBeenCalled();
  });
});
