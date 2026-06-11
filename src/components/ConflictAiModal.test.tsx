import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { ipcMock, pushToast } = vi.hoisted(() => ({
  ipcMock: {
    readFileChecked: vi.fn(),
    aiComplete: vi.fn(),
    writeFile: vi.fn(),
    markConflictResolved: vi.fn(),
  },
  pushToast: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("./Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));

import { ConflictAiModal } from "./ConflictAiModal";
import { CONFLICT_SYSTEM } from "../lib/aiConflict";

const CONFLICTED = "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nbottom\n";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConflictAiModal", () => {
  it("happy path: reads, proposes, applies via writeFile + markConflictResolved", async () => {
    ipcMock.readFileChecked.mockResolvedValue({ kind: "text", content: CONFLICTED, size: 64, mtime: 1 });
    ipcMock.aiComplete.mockResolvedValue({ text: "top\nmerged\nbottom\n", inputTokens: 1, outputTokens: 1, costUsd: 0 });
    ipcMock.writeFile.mockResolvedValue({ mtime: 2 });
    ipcMock.markConflictResolved.mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onResolved = vi.fn();

    render(
      <ConflictAiModal
        workspacePath="/repo"
        workspaceId="ws-1"
        file="src/a.ts"
        model="claude-sonnet-4-6"
        onClose={onClose}
        onResolved={onResolved}
      />,
    );

    await screen.findByText(/merged/);
    expect(ipcMock.readFileChecked).toHaveBeenCalledWith("/repo/src/a.ts");
    expect(ipcMock.aiComplete).toHaveBeenCalledWith(
      "claude-sonnet-4-6",
      CONFLICT_SYSTEM,
      expect.stringContaining("src/a.ts"),
      { workspaceId: "ws-1" }, // spend attribution (G5 follow-up)
    );
    expect(ipcMock.aiComplete.mock.calls[0][2]).toContain(CONFLICTED);

    await userEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() =>
      expect(ipcMock.writeFile).toHaveBeenCalledWith("/repo/src/a.ts", "top\nmerged\nbottom\n"),
    );
    expect(ipcMock.markConflictResolved).toHaveBeenCalledWith("/repo", "src/a.ts");
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "success" }));
    expect(onResolved).toHaveBeenCalled();
  });

  it("non-text reads surface an inline error and never call the model", async () => {
    ipcMock.readFileChecked.mockResolvedValue({ kind: "binary", size: 10, mtime: 1 });
    render(
      <ConflictAiModal workspacePath="/repo" file="img.png" model="m" onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    expect(await screen.findByText(/can't be resolved with AI/i)).toBeInTheDocument();
    expect(ipcMock.aiComplete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
  });

  it("AI failure surfaces an inline error", async () => {
    ipcMock.readFileChecked.mockResolvedValue({ kind: "text", content: CONFLICTED, size: 64, mtime: 1 });
    ipcMock.aiComplete.mockRejectedValue(new Error("model unavailable"));
    render(
      <ConflictAiModal workspacePath="/repo" file="src/a.ts" model="m" onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    expect(await screen.findByText(/model unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^apply$/i })).not.toBeInTheDocument();
  });

  it("warns when the proposal still contains conflict markers but allows apply", async () => {
    ipcMock.readFileChecked.mockResolvedValue({ kind: "text", content: CONFLICTED, size: 64, mtime: 1 });
    ipcMock.aiComplete.mockResolvedValue({ text: "still\n<<<<<<< HEAD\nbad\n", inputTokens: 1, outputTokens: 1, costUsd: 0 });
    render(
      <ConflictAiModal workspacePath="/repo" file="src/a.ts" model="m" onClose={vi.fn()} onResolved={vi.fn()} />,
    );
    expect(await screen.findByText(/still contains conflict markers/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply$/i })).toBeEnabled();
  });

  it("Discard closes without writing", async () => {
    ipcMock.readFileChecked.mockResolvedValue({ kind: "text", content: CONFLICTED, size: 64, mtime: 1 });
    ipcMock.aiComplete.mockResolvedValue({ text: "merged\n", inputTokens: 1, outputTokens: 1, costUsd: 0 });
    const onClose = vi.fn();
    render(
      <ConflictAiModal workspacePath="/repo" file="src/a.ts" model="m" onClose={onClose} onResolved={vi.fn()} />,
    );
    await screen.findByRole("button", { name: /^discard$/i });
    await userEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    expect(onClose).toHaveBeenCalled();
    expect(ipcMock.writeFile).not.toHaveBeenCalled();
  });
});
