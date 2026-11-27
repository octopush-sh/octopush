import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BacklogRowContextMenu } from "./BacklogRowContextMenu";

function menu(overrides: Partial<Parameters<typeof BacklogRowContextMenu>[0]> = {}) {
  return render(
    <BacklogRowContextMenu x={100} y={200} onCreateWorkspace={vi.fn()} onTestTicket={vi.fn()} onClose={vi.fn()} {...overrides} />,
  );
}

describe("BacklogRowContextMenu", () => {
  it("renders 'Create workspace' and 'Test this ticket'", () => {
    menu();
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Create workspace", "Test this ticket"]);
    expect(items[1]).toHaveAttribute("data-tour", "backlog-test-ticket");
  });

  it("clicking Create workspace calls onCreateWorkspace and onClose", () => {
    const onCreateWorkspace = vi.fn();
    const onTestTicket = vi.fn();
    const onClose = vi.fn();
    menu({ onCreateWorkspace, onTestTicket, onClose });
    fireEvent.click(screen.getByRole("menuitem", { name: "Create workspace" }));
    expect(onCreateWorkspace).toHaveBeenCalledOnce();
    expect(onTestTicket).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clicking Test this ticket calls onTestTicket and onClose", () => {
    const onCreateWorkspace = vi.fn();
    const onTestTicket = vi.fn();
    const onClose = vi.fn();
    menu({ onCreateWorkspace, onTestTicket, onClose });
    fireEvent.click(screen.getByRole("menuitem", { name: /Test this ticket/ }));
    expect(onTestTicket).toHaveBeenCalledOnce();
    expect(onCreateWorkspace).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    menu({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
