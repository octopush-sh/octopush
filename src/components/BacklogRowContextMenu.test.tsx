import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BacklogRowContextMenu } from "./BacklogRowContextMenu";

describe("BacklogRowContextMenu", () => {
  it("renders the 'Create workspace' menu item", () => {
    render(
      <BacklogRowContextMenu
        x={100}
        y={200}
        onCreateWorkspace={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByRole("menuitem")).toHaveTextContent("Create workspace");
  });

  it("clicking the menu item calls onCreateWorkspace and onClose", () => {
    const onCreateWorkspace = vi.fn();
    const onClose = vi.fn();
    render(
      <BacklogRowContextMenu
        x={100}
        y={200}
        onCreateWorkspace={onCreateWorkspace}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("menuitem"));
    expect(onCreateWorkspace).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("'Test this ticket' calls onTestTicket and onClose", () => {
    const onTestTicket = vi.fn();
    const onClose = vi.fn();
    render(<BacklogRowContextMenu x={1} y={2} onCreateWorkspace={vi.fn()} onTestTicket={onTestTicket} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Test this ticket" }));
    expect(onTestTicket).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <BacklogRowContextMenu
        x={100}
        y={200}
        onCreateWorkspace={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
