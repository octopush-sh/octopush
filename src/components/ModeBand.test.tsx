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
    const band = container.firstElementChild as HTMLElement;
    // The right track's floor is a variable that is 0px unless the tail is a
    // control (`tailMin`), so by default the two side tracks are equal.
    expect(band.className).toContain("grid-cols-[minmax(0,1fr)_auto_minmax(var(--modeband-tail-min,0px),1fr)]");
    expect(band.style.getPropertyValue("--modeband-tail-min")).toBe("");
    expect(band.children).toHaveLength(3);
    expect(band.children[1]).toContainElement(screen.getByRole("button", { name: /review/i }));
  });

  it("reserves a floor for a control tail, and marks it so the band can hide it whole", () => {
    const { container, rerender } = render(
      <ModeBand mode="run" onChange={vi.fn()} meta={<button type="button">a control</button>} tailMin={119} />,
    );
    const band = container.firstElementChild as HTMLElement;
    expect(band.className).toContain("octo-modeband");
    expect(band.style.getPropertyValue("--modeband-tail-min")).toBe("119px");
    expect((band.children[2] as HTMLElement).className).toContain("octo-modeband-control");
    expect(band.dataset.tail).toBe("control");

    // A read-out tail keeps today's behaviour: no floor, no marker.
    rerender(<ModeBand mode="run" onChange={vi.fn()} meta="No terminals" />);
    expect(band.style.getPropertyValue("--modeband-tail-min")).toBe("");
    expect((band.children[2] as HTMLElement).className).not.toContain("octo-modeband-control");
    expect(band.dataset.tail).toBeUndefined();
  });

  it("is a ladder: labels shed at 720px beside a control and at 600px anywhere; a control tail goes whole at 334px", async () => {
    // jsdom runs no container queries, so this reads the rungs from the sheet.
    // @ts-expect-error node:fs is untyped in this project
    const fs = await import("node:fs");
    const css: string = fs.readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/\.octo-modeband\s*\{[^}]*container-type:\s*inline-size;[^}]*container-name:\s*octo-modeband/);
    const rung = (px: number) =>
      css.match(new RegExp(`@container octo-modeband \\(max-width: ${px}px\\) \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    // Beside a control tail the labels go first, before a session's cell does.
    expect(rung(720)).toContain(
      '.octo-modeband[data-tail="control"] .octo-mode-seg:not([aria-pressed="true"]) > .octo-demote-mode-label',
    );
    expect(rung(720)).toMatch(/max-width:\s*0;/);
    // Only the modes that are not pressed lose their label, and they leave
    // the layout entirely (hidden, not just transparent).
    expect(rung(600)).toMatch(/^\s*\.octo-mode-seg:not\(\[aria-pressed="true"\]\) > \.octo-demote-mode-label/);
    expect(rung(600)).toMatch(/max-width:\s*0;/);
    expect(rung(600)).toMatch(/visibility:\s*hidden;/);
    // A hidden control is out of the tab order, not merely out of sight.
    expect(rung(334)).toMatch(/\.octo-modeband-control\s*\{\s*visibility:\s*hidden;/);
  });

  it("keeps the tail inside its track so it cannot overlap the switcher", () => {
    // Regression (visual audit #315): a bare `1fr` track has a content-sized
    // minimum, and a `justify-self-end` cell is sized to its content, so a
    // long nowrap tail kept its full width and was drawn over the pill.
    const { container } = render(
      <ModeBand mode="direct" onChange={vi.fn()} meta="3k / 200k context" />,
    );
    const band = container.firstElementChild as HTMLElement;
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
