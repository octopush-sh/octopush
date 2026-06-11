import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AiFindingCard } from "./AiFindingCard";
import type { AiFinding } from "../../lib/aiReview";

const f: AiFinding = { severity: "high", category: "security", title: "Unescaped path", detail: "x", file: "a.rs", line: 12 };
const noFile: AiFinding = { severity: "low", category: "style", title: "Naming", detail: "", file: null, line: null };

describe("AiFindingCard", () => {
  it("renders category + title + jump link", () => {
    const onJump = vi.fn();
    const { getByText, getByRole } = render(<AiFindingCard finding={f} onJump={onJump} />);
    expect(getByText("Unescaped path")).toBeTruthy();
    expect(getByText(/security/i)).toBeTruthy();
    fireEvent.click(getByRole("button"));
    expect(onJump).toHaveBeenCalledWith("a.rs", 12);
  });
  it("is not clickable when there is no file", () => {
    const { queryByRole } = render(<AiFindingCard finding={noFile} onJump={() => {}} />);
    expect(queryByRole("button")).toBeNull();
  });
  it("carries severity via colored dot + tooltip, with no text label and no brass", () => {
    const { getByRole, queryByText, container } = render(<AiFindingCard finding={f} onJump={() => {}} />);
    const dot = getByRole("img", { name: "severity: high" });
    expect(dot).toHaveAttribute("title", "severity: high");
    expect(dot.style.background).toContain("var(--color-octo-rouge)");
    expect(queryByText(/·\s*high/)).toBeNull(); // the old "category · severity" label is gone
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.borderLeftColor).toBe("var(--color-octo-rouge)");
  });
  it("maps medium to warning and low to mute", () => {
    const med = render(<AiFindingCard finding={{ ...f, severity: "medium" }} onJump={() => {}} />);
    expect((med.container.firstElementChild as HTMLElement).style.borderLeftColor).toBe("var(--color-octo-warning)");
    const low = render(<AiFindingCard finding={noFile} onJump={() => {}} />);
    expect((low.container.firstElementChild as HTMLElement).style.borderLeftColor).toBe("var(--color-octo-mute)");
  });
});
