import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../lib/ipc", () => ({ ipc: { aiComplete: vi.fn() } }));
// ModelPicker hits IPC on mount; stub it to a no-op for this unit test.
vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }));
import { ipc } from "../../lib/ipc";
import { useAiReview } from "../../stores/aiReviewStore";
import { AiReviewPanel } from "./AiReviewPanel";

const okJson = JSON.stringify({ summary: "the change", findings: [{ severity: "high", category: "bug", title: "Boom", detail: "d", file: "a.ts", line: 2 }] });

beforeEach(() => {
  localStorage.clear();
  useAiReview.setState({ models: {}, reviews: {}, runGen: {}, collapsed: {} });
  (ipc.aiComplete as any).mockReset();
});

describe("AiReviewPanel", () => {
  it("runs the review and renders findings", async () => {
    (ipc.aiComplete as any).mockResolvedValue({ text: okJson, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    const onJump = vi.fn();
    const { getByRole, getByText } = render(<AiReviewPanel workspaceId="w1" gitDiff="DIFF" onJump={onJump} />);
    fireEvent.click(getByRole("button", { name: /review this change/i }));
    await waitFor(() => expect(getByText("Boom")).toBeTruthy());
    expect(getByText("the change")).toBeTruthy();
    expect(ipc.aiComplete).toHaveBeenCalled();
  });
  it("shows nothing-to-review for an empty diff", () => {
    const { getByText } = render(<AiReviewPanel workspaceId="w1" gitDiff="   " onJump={() => {}} />);
    expect(getByText(/nothing to review/i)).toBeTruthy();
  });
  it("shows an error state on failure", async () => {
    (ipc.aiComplete as any).mockRejectedValue(new Error("API key not configured"));
    const { getByRole, getByText } = render(<AiReviewPanel workspaceId="w1" gitDiff="DIFF" onJump={() => {}} />);
    fireEvent.click(getByRole("button", { name: /review this change/i }));
    await waitFor(() => expect(getByText(/API key not configured/i)).toBeTruthy());
  });
  it("header toggles collapse with a dynamic title and survives a remount (store-backed)", () => {
    const first = render(<AiReviewPanel workspaceId="w1" gitDiff="DIFF" onJump={() => {}} />);
    const header = first.getByRole("button", { name: /AI Review/i });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveAttribute("title", "Expand AI review");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).toHaveAttribute("title", "Collapse AI review");
    expect(useAiReview.getState().collapsedFor("w1")).toBe(false);

    // Mode switch unmounts the panel; on return the panel is still expanded.
    first.unmount();
    const second = render(<AiReviewPanel workspaceId="w1" gitDiff="DIFF" onJump={() => {}} />);
    expect(second.getByRole("button", { name: /AI Review/i })).toHaveAttribute("aria-expanded", "true");
  });
  it("starting a review expands the panel", () => {
    (ipc.aiComplete as any).mockReturnValue(new Promise(() => {}));
    const { getByRole } = render(<AiReviewPanel workspaceId="w1" gitDiff="DIFF" onJump={() => {}} />);
    fireEvent.click(getByRole("button", { name: /review this change/i }));
    expect(useAiReview.getState().collapsedFor("w1")).toBe(false);
    expect(getByRole("button", { name: /AI Review/i })).toHaveAttribute("aria-expanded", "true");
  });
});
