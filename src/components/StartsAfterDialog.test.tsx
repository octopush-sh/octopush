import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Workspace } from "../lib/types";

const save = vi.fn();
const clear = vi.fn();
vi.mock("../stores/prerequisitesStore", async () => {
  const { create } = await import("zustand");
  return {
    usePrerequisitesStore: create(() => ({
      byWs: {} as Record<string, unknown>,
      save: (...a: unknown[]) => save(...a),
      clear: (...a: unknown[]) => clear(...a),
    })),
  };
});

const { StartsAfterDialog } = await import("./StartsAfterDialog");
const { usePrerequisitesStore } = await import("../stores/prerequisitesStore");

const ws = (id: string): Workspace => ({
  id, projectId: "p1", name: id, task: "", branch: id, worktreePath: null, setupScript: "",
  status: "active", createdAt: "", lastActive: "", glyph: null, tint: null, linkedIssueKey: null, fromBranch: null,
});
const open = (onClose = vi.fn()) =>
  render(<StartsAfterDialog workspace={ws("billing")} candidates={[ws("auth"), ws("docs")]} onClose={onClose} />);

beforeEach(() => {
  vi.clearAllMocks();
  usePrerequisitesStore.setState({ byWs: {} });
});

describe("StartsAfterDialog", () => {
  it("saves the chosen mission and condition, auto-start off by default", async () => {
    save.mockResolvedValue(true);
    const onClose = vi.fn();
    open(onClose);

    expect(screen.getByTestId("starts-after-auto-start")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Stop waiting")).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Mission" }));
    fireEvent.click(screen.getByRole("option", { name: "docs" }));
    fireEvent.click(screen.getByRole("radio", { name: "Pull request merges" }));
    fireEvent.click(screen.getByText("Wait for it"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith("p1", "billing", "docs", "pr_merged", false);
  });

  it("opens on the existing link and can stop the wait", async () => {
    usePrerequisitesStore.setState({
      byWs: { billing: { workspaceId: "billing", afterWorkspaceId: "docs", afterCondition: "pr_merged", branchFromPrerequisite: false, autoStart: true } },
    });
    clear.mockResolvedValue(true);
    const onClose = vi.fn();
    open(onClose);

    expect(screen.getByRole("combobox", { name: "Mission" })).toHaveTextContent("docs");
    expect(screen.getByRole("radio", { name: "Pull request merges" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("starts-after-auto-start")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByText("Stop waiting"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(clear).toHaveBeenCalledWith("billing");
  });

  it("stays open when stopping the wait is refused", async () => {
    usePrerequisitesStore.setState({
      byWs: { billing: { workspaceId: "billing", afterWorkspaceId: "docs", afterCondition: "run_finished", branchFromPrerequisite: false, autoStart: false } },
    });
    clear.mockResolvedValue(false);
    const onClose = vi.fn();
    open(onClose);

    fireEvent.click(screen.getByText("Stop waiting"));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("billing"));
    await waitFor(() => expect(screen.getByText("Stop waiting")).not.toBeDisabled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Stop waiting")).toBeInTheDocument();
  });

  it("says so when there is nothing to wait on", () => {
    render(<StartsAfterDialog workspace={ws("billing")} candidates={[]} onClose={vi.fn()} />);
    expect(screen.getByText("This project has no other mission to wait on.")).toBeInTheDocument();
    expect(screen.queryByText("Wait for it")).toBeNull();
  });
});
