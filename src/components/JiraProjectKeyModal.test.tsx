import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JiraProjectKeyModal } from "./JiraProjectKeyModal";

vi.mock("../lib/ipc", () => ({
  ipc: {},
}));

describe("JiraProjectKeyModal", () => {
  it("renders with initial value pre-filled in the input", () => {
    render(
      <JiraProjectKeyModal
        initialValue="MYPROJ"
        projectName="My Project"
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Jira project key")).toHaveValue("MYPROJ");
    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  it("Save calls onSave with trimmed value when non-empty", () => {
    const onSave = vi.fn();
    render(
      <JiraProjectKeyModal
        initialValue="  PROJ  "
        projectName="Test"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith("PROJ");
  });

  it("Save calls onSave(null) when value is empty after trim", () => {
    const onSave = vi.fn();
    render(
      <JiraProjectKeyModal
        initialValue=""
        projectName="Test"
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    // Value is already empty
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
