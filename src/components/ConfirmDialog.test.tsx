import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("renders the title and body", () => {
    render(
      <ConfirmDialog
        title="Delete workspace?"
        body="This cannot be undone."
        destructiveLabel="Delete workspace"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Delete workspace?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("calls onConfirm when the destructive button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        body="Irreversible."
        destructiveLabel="Delete workspace"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Delete workspace"));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        body="Irreversible."
        destructiveLabel="Delete workspace"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("uses custom cancelLabel when provided", () => {
    render(
      <ConfirmDialog
        title="Delete?"
        body="Irreversible."
        destructiveLabel="Delete workspace"
        cancelLabel="Go back"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Go back")).toBeInTheDocument();
  });

  it("renders no secondary button unless both label and handler are provided", () => {
    render(
      <ConfirmDialog
        title="Delete?"
        body="Irreversible."
        destructiveLabel="Delete workspace"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Only Cancel + confirm.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("renders the secondary button between Cancel and the confirm and calls onSecondary", () => {
    const onSecondary = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="File changed on disk"
        body="Pick one."
        destructiveLabel="Overwrite"
        secondaryLabel="Reload from disk"
        cancelLabel="Keep editing"
        onSecondary={onSecondary}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Keep editing",
      "Reload from disk",
      "Overwrite",
    ]);
    fireEvent.click(screen.getByText("Reload from disk"));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape triggers onCancel — never the secondary or the confirm", () => {
    const onSecondary = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="File changed on disk"
        body="Pick one."
        destructiveLabel="Overwrite"
        secondaryLabel="Reload from disk"
        cancelLabel="Keep editing"
        onSecondary={onSecondary}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onSecondary).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel on Escape key", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        body="Irreversible."
        destructiveLabel="Delete workspace"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onConfirm on Enter key", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        title="Delete?"
        body="Irreversible."
        destructiveLabel="Delete workspace"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalled();
  });
});
