import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FileNameDialog } from "./FileNameDialog";

function renderDialog(overrides: Partial<Parameters<typeof FileNameDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <FileNameDialog
      title="New file"
      label="File name"
      confirmLabel="Create"
      onSubmit={onSubmit}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSubmit, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FileNameDialog", () => {
  it("renders title, label, and confirm button", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "New file" })).toBeInTheDocument();
    expect(screen.getByLabelText("File name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("autofocuses the input and pre-fills the initial value", () => {
    renderDialog({ initial: "Main.java", confirmLabel: "Rename" });
    const input = screen.getByLabelText("File name");
    expect(input).toHaveValue("Main.java");
    expect(document.activeElement).toBe(input);
  });

  it("submits the typed name on Enter", async () => {
    const { onSubmit } = renderDialog();
    await userEvent.type(screen.getByLabelText("File name"), "notes.md{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("notes.md");
  });

  it("submits via the confirm button", async () => {
    const { onSubmit } = renderDialog();
    await userEvent.type(screen.getByLabelText("File name"), "notes.md");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith("notes.md");
  });

  it("trims surrounding whitespace before submitting", async () => {
    const { onSubmit } = renderDialog();
    await userEvent.type(screen.getByLabelText("File name"), "  notes.md  {Enter}");
    expect(onSubmit).toHaveBeenCalledWith("notes.md");
  });

  it("blocks an empty name with an inline error and no onSubmit call", async () => {
    const { onSubmit } = renderDialog();
    await userEvent.type(screen.getByLabelText("File name"), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/name is required/i);
  });

  it("blocks names containing a forward slash", async () => {
    const { onSubmit } = renderDialog();
    await userEvent.type(screen.getByLabelText("File name"), "a/b{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/slash/i);
  });

  it("blocks names containing a backslash", async () => {
    const { onSubmit } = renderDialog();
    await userEvent.type(screen.getByLabelText("File name"), "a\\b{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/slash/i);
  });

  it('blocks "." and ".." as names', async () => {
    const { onSubmit } = renderDialog();
    const input = screen.getByLabelText("File name");
    await userEvent.type(input, ".{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "..{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears the inline error once the value changes", async () => {
    renderDialog();
    const input = screen.getByLabelText("File name");
    await userEvent.type(input, "a/b{Enter}");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.type(input, "x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Cancel calls onClose without submitting", async () => {
    const { onSubmit, onClose } = renderDialog();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
