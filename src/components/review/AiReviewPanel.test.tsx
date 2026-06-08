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
  useAiReview.setState({ models: {}, reviews: {} });
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
});
