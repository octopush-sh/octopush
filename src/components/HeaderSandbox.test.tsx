/**
 * The header's sandbox toggle (#1230): turning it off asks first, turning it
 * on doesn't, and a read-only mission's forced sandbox shows and stays on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({ ipc: {} }));

import { useMissionsStore } from "../stores/missionsStore";
import { HeaderSandbox, SANDBOX_TITLES } from "./HeaderSandbox";

const setExecIsolation = vi.fn();

beforeEach(() => {
  setExecIsolation.mockReset().mockResolvedValue({ unlinked: [], uncopied: [], keptCopies: [] });
  useMissionsStore.setState({ setExecIsolation });
});

const mount = (execIsolation: string, gitIsolation = "worktree") =>
  render(<HeaderSandbox missionId="m1" execIsolation={execIsolation} gitIsolation={gitIsolation} />);

describe("HeaderSandbox", () => {
  it("turning the sandbox off asks first, and only the confirmation changes the mission", async () => {
    mount("sandbox");
    const shield = screen.getByRole("button", { name: "Sandbox on" });
    expect(shield).toHaveAttribute("title", SANDBOX_TITLES.on);
    expect(shield).toHaveAttribute("aria-pressed", "true");
    expect(shield).toHaveAttribute("data-tour", "header-sandbox");
    fireEvent.click(shield);
    const dialog = screen.getByRole("dialog", { name: "Turn off the sandbox" });
    expect(dialog).toHaveTextContent(/write outside the workspace/);
    expect(dialog).toHaveTextContent(/applies from the next Talk turn or stage/);
    expect(screen.getByRole("button", { name: "Keep the sandbox" })).toHaveFocus();
    expect(setExecIsolation).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Let its agents write outside the workspace" }));
    });
    expect(setExecIsolation).toHaveBeenCalledWith("m1", "none");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeping the sandbox, or Esc, changes nothing", () => {
    mount("sandbox");
    fireEvent.click(screen.getByRole("button", { name: "Sandbox on" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep the sandbox" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sandbox on" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setExecIsolation).not.toHaveBeenCalled();
  });

  it("Enter never confirms", () => {
    mount("sandbox");
    fireEvent.click(screen.getByRole("button", { name: "Sandbox on" }));
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "Turn off the sandbox" })).toBeInTheDocument();
    expect(setExecIsolation).not.toHaveBeenCalled();
  });

  it("a dialog opened on one mission closes on a switch, and never acts on the next one", () => {
    const view = mount("sandbox");
    fireEvent.click(screen.getByRole("button", { name: "Sandbox on" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<HeaderSandbox missionId="m2" execIsolation="sandbox" gitIsolation="worktree" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Let its agents write outside the workspace" })).toBeNull();
    // Back on m1, it doesn't come back by itself.
    view.rerender(<HeaderSandbox missionId="m1" execIsolation="sandbox" gitIsolation="worktree" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setExecIsolation).not.toHaveBeenCalled();
  });

  it("turning the sandbox on doesn't ask", async () => {
    mount("none");
    const off = screen.getByRole("button", { name: "Sandbox off" });
    expect(off).toHaveAttribute("title", SANDBOX_TITLES.off);
    expect(off).toHaveAttribute("aria-pressed", "false");
    await act(async () => {
      fireEvent.click(off);
    });
    expect(setExecIsolation).toHaveBeenCalledWith("m1", "sandbox");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a read-only mission shows its forced sandbox, says why, and can't turn it off", () => {
    mount("none", "readonly");
    const shield = screen.getByRole("button", { name: "Sandbox on" });
    expect(shield).toHaveAttribute("title", SANDBOX_TITLES.forced);
    expect(SANDBOX_TITLES.forced).toMatch(/^Read-only mission: .*The sandbox is always on\.$/);
    expect(shield).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(shield);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setExecIsolation).not.toHaveBeenCalled();
  });

  it("shows nothing without a mission", () => {
    render(<HeaderSandbox missionId={null} execIsolation="sandbox" gitIsolation={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
