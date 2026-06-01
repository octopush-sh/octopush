import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExistingWorkspaceAlertModal } from "./ExistingWorkspaceAlertModal";

describe("ExistingWorkspaceAlertModal", () => {
  it("renders the ticket key and workspace name in the body text", () => {
    render(
      <ExistingWorkspaceAlertModal
        ticketKey="PROJ-42"
        workspaceName="my-feature-branch"
        onContinue={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText("PROJ-42")).toBeInTheDocument();
    expect(screen.getByText(/my-feature-branch/)).toBeInTheDocument();
  });

  it("clicking Continue calls onContinue", () => {
    const onContinue = vi.fn();
    render(
      <ExistingWorkspaceAlertModal
        ticketKey="PROJ-42"
        workspaceName="my-feature-branch"
        onContinue={onContinue}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText("Continue"));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("clicking Cancel or pressing Escape calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <ExistingWorkspaceAlertModal
        ticketKey="PROJ-42"
        workspaceName="my-feature-branch"
        onContinue={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
