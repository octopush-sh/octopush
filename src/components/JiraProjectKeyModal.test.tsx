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

  it("offers Jira, Epiku and None, and saves the Epiku project", () => {
    const onSave = vi.fn();
    const tracker = { choice: null, epikuProject: null, epikuDefault: "sample-project", epikuConnected: true };
    render(<JiraProjectKeyModal initialValue="" projectName="P" tracker={tracker} onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Jira" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Epiku" }));
    const field = screen.getByLabelText("Epiku project");
    expect(field).toHaveAttribute("placeholder", "sample-project");
    fireEvent.change(field, { target: { value: " other-project " } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(null, { choice: "epiku", epikuProject: "other-project" });
  });

  it("leaves an untouched default unset, and None stores none", () => {
    const onSave = vi.fn();
    const tracker = { choice: null, epikuProject: null, epikuDefault: null, epikuConnected: false };
    render(<JiraProjectKeyModal initialValue="OCT" projectName="P" tracker={tracker} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenLastCalledWith("OCT", { choice: null, epikuProject: null });
    fireEvent.click(screen.getByRole("radio", { name: "None" }));
    expect(screen.getByText("This project shows no tickets and no backlog.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSave).toHaveBeenLastCalledWith("OCT", { choice: "none", epikuProject: null });
  });
});
