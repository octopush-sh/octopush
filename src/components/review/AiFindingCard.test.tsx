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
});
