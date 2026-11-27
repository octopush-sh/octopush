import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import type { PermissionMode, ThreadMode } from "../../lib/permissionModes";

const ipcMock = vi.hoisted(() => ({
  getThreadPermissionMode: vi.fn(),
  setThreadPermissionMode: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));

import { PermissionModeControl } from "./PermissionModeControl";
import { usePermissionModeStore } from "../../stores/permissionModeStore";

/** What `get_thread_permission_mode` answers: no `forced`, the store works it out. */
let backend: Omit<ThreadMode, "forced">;

beforeEach(() => {
  usePermissionModeStore.setState({ byThread: {} });
  backend = { stored: "edit", effective: "edit" };
  ipcMock.getThreadPermissionMode.mockReset().mockImplementation(async () => ({ ...backend }));
  ipcMock.setThreadPermissionMode.mockReset().mockImplementation(async (_thread: string, mode: PermissionMode) => {
    backend = { stored: mode, effective: mode };
    return mode;
  });
});

const labels = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitemradio")
    .map((item) => `${item.querySelector(".font-serif")?.textContent}:${item.getAttribute("aria-checked")}`);

describe("PermissionModeControl", () => {
  it("shows the mode the turns run in, and its menu sets another (#1231)", async () => {
    render(<PermissionModeControl threadId="t1" streaming={false} />);
    const chip = await screen.findByRole("button", { name: "Permission mode: Edit freely" });
    expect(chip).toHaveAttribute("data-tour", "talk-permission-mode");
    expect(chip.getAttribute("title")).toContain("⌘⌥P switches to Plan only (with the focus in the composer)");

    fireEvent.click(chip);
    const menu = screen.getByRole("menu", { name: "Permission mode" });
    expect(labels(menu)).toEqual(["Plan only:false", "Ask first:false", "Edit freely:true"]);
    const items = within(menu).getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.click(items[1]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Permission mode: Ask first" })).toBeInTheDocument();
    await waitFor(() => expect(ipcMock.setThreadPermissionMode).toHaveBeenCalledWith("t1", "ask"));

    // Esc closes the menu and hands the focus back, choosing nothing.
    fireEvent.click(screen.getByRole("button", { name: "Permission mode: Ask first" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Permission mode: Ask first" }));
    expect(ipcMock.setThreadPermissionMode).toHaveBeenCalledTimes(1);
  });

  it("a read-only mission's Plan only shows a lock and can't be changed", async () => {
    backend = { stored: "edit", effective: "plan" };
    render(<PermissionModeControl threadId="t1" streaming={false} />);
    const chip = await screen.findByRole("button", { name: /^Permission mode: Plan only\. This workspace's mission is read-only/ });
    expect(chip).toHaveAttribute("aria-disabled", "true");
    expect(chip.getAttribute("title")).toContain("can't be changed");
    fireEvent.click(chip);
    expect(screen.queryByRole("menu")).toBeNull();
    await act(() => usePermissionModeStore.getState().cycle("t1"));
    await act(() => usePermissionModeStore.getState().set("t1", "edit"));
    expect(ipcMock.setThreadPermissionMode).not.toHaveBeenCalled();
  });

  it("cycles in order, and a write that fails puts the chip back", async () => {
    render(<PermissionModeControl threadId="t1" streaming={false} />);
    await screen.findByRole("button", { name: "Permission mode: Edit freely" });
    await act(() => usePermissionModeStore.getState().cycle("t1"));
    expect(screen.getByRole("button", { name: "Permission mode: Plan only" })).toBeInTheDocument();
    await act(() => usePermissionModeStore.getState().cycle("t1"));
    expect(ipcMock.setThreadPermissionMode.mock.calls).toEqual([
      ["t1", "plan"],
      ["t1", "ask"],
    ]);

    ipcMock.setThreadPermissionMode.mockRejectedValueOnce(new Error("database is locked"));
    await act(() => usePermissionModeStore.getState().set("t1", "edit"));
    expect(screen.getByRole("button", { name: "Permission mode: Ask first" })).toBeInTheDocument();
  });
});
