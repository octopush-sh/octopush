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

  // The marker sits in the pane's left gutter, which belongs to the pane and
  // not to any block. Hiding it there would make it unreachable: it goes
  // pointer-events-none the moment it hides, so the pointer could never
  // finish crossing the gap to click it.
  it("stays visible while the pointer crosses the gutter toward it", () => {
    render(<MarkdownPreview source={DOC} onJumpToLine={vi.fn()} />);
    fireEvent.mouseOver(screen.getByText("A paragraph of prose."));
    expect(marker()?.className).toContain("opacity-100");

    fireEvent.mouseOver(screen.getByTestId("markdown-preview"));
    expect(marker()).toHaveTextContent("3");
    expect(marker()?.className).toContain("opacity-100");
    expect(marker()?.className).not.toContain("pointer-events-none");
  });

  it("keeps the marker mounted but inert once the pointer leaves the pane", () => {
    render(<MarkdownPreview source={DOC} onJumpToLine={vi.fn()} />);
    fireEvent.mouseOver(screen.getByText("A paragraph of prose."));
    expect(marker()?.className).toContain("opacity-100");
    fireEvent.mouseLeave(screen.getByTestId("markdown-preview"));
    expect(marker()?.className).toContain("opacity-0");
    expect(marker()?.className).toContain("pointer-events-none");
  });

  // The preview renders the LIVE buffer: typing in the source column reflows
  // the document under a resting pointer, so a marker measured before the edit
  // now points somewhere else.
  it("hides a stale marker when the buffer changes underneath it", () => {
    const { rerender } = render(<MarkdownPreview source={DOC} onJumpToLine={vi.fn()} />);
    fireEvent.mouseOver(screen.getByText("A paragraph of prose."));
    expect(marker()?.className).toContain("opacity-100");

    rerender(<MarkdownPreview source={`# New heading\n\n${DOC}`} onJumpToLine={vi.fn()} />);
    expect(marker()?.className).toContain("opacity-0");
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

  // A table is the one block whose rows are individually addressable, and the
  // one whose marker position can't come from `offsetTop` (a <tr>'s
  // offsetParent is its <table>, not the document wrapper).
  describe("tables", () => {
    const TABLE = ["| A | B |", "| - | - |", "| 1 | 2 |", "| 3 | 4 |"].join("\n");

    it("stamps the wrapper and every body row", () => {
      const { container } = render(<MarkdownPreview source={TABLE} />);
      expect(container.querySelector("[data-md-line]")).toHaveAttribute("data-md-line", "1");
      const rows = container.querySelectorAll("tbody tr");
      expect(rows[0]).toHaveAttribute("data-md-line", "3");
      expect(rows[1]).toHaveAttribute("data-md-line", "4");
    });

    it("⌘-click on a cell jumps to that row, not to the table", () => {
      const onJumpToLine = vi.fn();
      render(<MarkdownPreview source={TABLE} onJumpToLine={onJumpToLine} />);
      fireEvent.click(screen.getByRole("cell", { name: "4" }), { metaKey: true });
      expect(onJumpToLine).toHaveBeenCalledWith(4);
    });

    it("positions the row marker against the document, not the table", () => {
      const { container } = render(<MarkdownPreview source={TABLE} onJumpToLine={vi.fn()} />);
      const body = container.querySelector(".relative") as HTMLElement;
      const row = container.querySelectorAll("tbody tr")[1] as HTMLElement;
      // jsdom reports 0 for every layout metric, so stub the two rects the
      // measurement actually reads. `offsetTop` stays 0 — a regression back to
      // it would place the marker at the top of the document.
      body.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
      row.getBoundingClientRect = () => ({ top: 460 }) as DOMRect;

      fireEvent.mouseOver(row);
      expect(marker()).toHaveTextContent("4");
      expect((marker() as HTMLElement).style.top).toBe("360px");
    });
  });
});
