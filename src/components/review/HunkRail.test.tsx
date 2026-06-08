import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { HunkRail } from "./HunkRail";

describe("HunkRail", () => {
  const base = { range: "lines 1–4", additions: 2, deletions: 1, focused: false, staged: false };
  it("calls onAccept", () => {
    const onAccept = vi.fn();
    const { getByRole } = render(<HunkRail {...base} onAccept={onAccept} onReject={() => {}} onWhy={() => {}} />);
    fireEvent.click(getByRole("button", { name: /accept/i }));
    expect(onAccept).toHaveBeenCalled();
  });
  it("shows staged + hides actions when staged", () => {
    const { queryByRole, container } = render(<HunkRail {...base} staged onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} />);
    expect(queryByRole("button", { name: /accept/i })).toBeNull();
    expect(container.textContent?.toLowerCase()).toContain("staged");
  });
  it("focused adds the bright rule data attr", () => {
    const { container } = render(<HunkRail {...base} focused onAccept={()=>{}} onReject={()=>{}} onWhy={()=>{}} />);
    expect(container.querySelector('[data-focused="true"]')).toBeTruthy();
  });
});
