import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyProjectState } from "./EmptyProjectState";

const mockIsModalOpen = vi.fn(() => false);
vi.mock("./ModalShell", () => ({
  isModalOpen: () => mockIsModalOpen(),
}));

describe("EmptyProjectState", () => {
  beforeEach(() => {
    mockIsModalOpen.mockReturnValue(false);
  });

  it("renders the 'pick another project from the rail' hint and no Switch project button", () => {
    render(<EmptyProjectState projectName="Test" onCreateWorkspace={vi.fn()} />);
    expect(screen.getByText(/pick another project from the rail/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch project/i })).not.toBeInTheDocument();
  });

  it("renders no dismiss affordance when onDismiss is omitted (the trap-free but nowhere-to-go case)", () => {
    render(<EmptyProjectState projectName="Test" onCreateWorkspace={vi.fn()} />);
    expect(screen.queryByTitle(/dismiss/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/back to/i)).not.toBeInTheDocument();
  });

  it("renders a dismiss button with a 'Back to <workspace>' tooltip and calls onDismiss on click", () => {
    const onDismiss = vi.fn();
    render(
      <EmptyProjectState
        projectName="Test"
        onCreateWorkspace={vi.fn()}
        onDismiss={onDismiss}
        dismissWorkspaceName="alpha"
      />,
    );
    const button = screen.getByTitle("Back to alpha");
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls onDismiss on Escape", () => {
    const onDismiss = vi.fn();
    render(
      <EmptyProjectState projectName="Test" onCreateWorkspace={vi.fn()} onDismiss={onDismiss} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on Escape while a modal is stacked on top", () => {
    mockIsModalOpen.mockReturnValue(true);
    const onDismiss = vi.fn();
    render(
      <EmptyProjectState projectName="Test" onCreateWorkspace={vi.fn()} onDismiss={onDismiss} />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
