import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeBand } from "./ModeBand";

describe("ModeBand", () => {
  it("switches modes from the band", () => {
    const onChange = vi.fn();
    render(<ModeBand mode="run" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /review/i }));
    expect(onChange).toHaveBeenCalledWith("review");
  });

  it("renders the status tail when there is one", () => {
    render(<ModeBand mode="run" onChange={vi.fn()} meta="2 terminals" />);
    expect(screen.getByText("2 terminals")).toBeInTheDocument();
  });

  it("renders no tail when the mode has nothing to report", () => {
    const { container } = render(<ModeBand mode="talk" onChange={vi.fn()} meta={null} />);
    // Only the switcher's own buttons — no empty text node holding a slot open.
    expect(container.querySelectorAll("span.truncate")).toHaveLength(0);
  });

  it("centres the switcher in a track the tail cannot shift", () => {
    // The tail lives in its own grid track, so a long tail truncates instead
    // of pushing the pill off centre. jsdom has no layout, so this asserts the
    // structure that guarantees it: equal 1fr side tracks around an auto one.
    const { container } = render(
      <ModeBand mode="review" onChange={vi.fn()} meta="7 files changed · +214 −61" />,
    );
    const band = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    // The right track's floor is a variable that is 0px unless the tail is a
    // control (`tailMin`), so by default the two side tracks are equal.
    expect(band.className).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(var(--modeband-tail-min,0px),1fr)]");
    expect(band.style.getPropertyValue("--modeband-tail-min")).toBe("");
    expect(band.children).toHaveLength(3);
    expect(band.children[1]).toContainElement(screen.getByRole("button", { name: /review/i }));
  });

  it("reserves a floor for a control tail, and a last one for the narrowest band", () => {
    const { container, rerender } = render(
      <ModeBand
        mode="run"
        onChange={vi.fn()}
        meta={<button type="button">a control</button>}
        tailMin={119}
        tailLastMin={26}
      />,
    );
    // The container wraps the grid, so a container query can change the
    // grid's own columns.
    const outer = container.firstElementChild as HTMLElement;
    const grid = outer.firstElementChild as HTMLElement;
    expect(outer.className).toBe("octo-modeband");
    expect(grid.className).toContain("octo-modeband-grid");
    expect(outer.style.getPropertyValue("--modeband-tail-min")).toBe("119px");
    expect(outer.style.getPropertyValue("--modeband-tail-last")).toBe("26px");
    expect(grid.dataset.tail).toBe("control");

    // A read-out tail keeps today's behaviour: no floor, no marker.
    rerender(<ModeBand mode="run" onChange={vi.fn()} meta="No terminals" />);
    expect(outer.style.getPropertyValue("--modeband-tail-min")).toBe("");
    expect(outer.style.getPropertyValue("--modeband-tail-last")).toBe("");
    expect(grid.dataset.tail).toBeUndefined();
  });

  it("is a ladder: inactive labels shed at 720px in every mode; a control tail keeps its last floor at 334px", async () => {
    // jsdom runs no container queries, so this reads the rungs from the sheet.
    // @ts-expect-error node:fs is untyped in this project
    const fs = await import("node:fs");
    const css: string = fs.readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.octo-modeband\s*\{[^}]*container-type:\s*inline-size;[^}]*container-name:\s*octo-modeband/);
    const rung = (px: number) =>
      css.match(new RegExp(`@container octo-modeband \\(max-width: ${px}px\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    // One rung for every mode: the switcher must not change width with the
    // mode, or the segment under the pointer becomes another mode mid-click.
    // Only the modes that are not pressed lose their label, and they leave
    // the layout entirely (hidden, not just transparent).
    expect(rung(720)).toMatch(/^\s*\.octo-mode-seg:not\(\[aria-pressed="true"\]\) > \.octo-demote-mode-label/);
    expect(rung(720)).not.toContain("data-tail");
    expect(rung(720)).toMatch(/max-width:\s*0;/);
    expect(rung(720)).toMatch(/visibility:\s*hidden;/);
    expect(rung(600)).toBe("");
    // Past the floor the track keeps the last rung's width instead of
    // reserving the floor for a hidden line: the control stays, shed.
    expect(rung(334)).toMatch(
      /\.octo-modeband-grid\[data-tail="control"\]\s*\{\s*--modeband-tail-min:\s*var\(--modeband-tail-last\);/,
    );
    expect(rung(334)).not.toContain("visibility");
  });

  it("caps the mode label near its own width, so its collapse doesn't lag", async () => {
    // @ts-expect-error node:fs is untyped in this project
    const fs = await import("node:fs");
    const css: string = fs.readFileSync("src/styles.css", "utf8");
    const block = css.match(/\.octo-demote\.octo-demote-mode-label\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/max-width:\s*calc\(7 \* \(1ch \+ 0\.2em\)\);/);
    expect(block).not.toContain("40ch");
  });

  it("keeps the tail inside its track so it cannot overlap the switcher", () => {
    // Regression (visual audit #315): a bare `1fr` track has a content-sized
    // minimum, and a `justify-self-end` cell is sized to its content, so a
    // long nowrap tail kept its full width and was drawn over the pill.
    const { container } = render(
      <ModeBand mode="direct" onChange={vi.fn()} meta="3k / 200k context" />,
    );
    const band = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    expect(band.className).not.toMatch(/grid-cols-\[1fr|_1fr\]/);
    const tailCell = band.children[2] as HTMLElement;
    expect(tailCell.className).not.toContain("justify-self-");
    expect(tailCell.className).toMatch(/(^|\s)flex(\s|$)/);
    expect(tailCell.className).toContain("min-w-0");
    expect(tailCell.className).toContain("justify-end");
    const tail = screen.getByText("3k / 200k context");
    expect(tail.className).toContain("min-w-0");
    expect(tail.className).toContain("truncate");
  });
});
