import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
