/**
 * The permission mode's chord (#1231): ⌘⌥P cycles the conversation's mode
 * only while the focus is in the Composer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const modes = vi.hoisted(() => ({
  getThreadPermissionMode: vi.fn(),
  setThreadPermissionMode: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({
  // Everything else the Composer reads answers with nothing.
  ipc: new Proxy(modes as Record<string, unknown>, {
    get: (target, name: string) => target[name] ?? (async () => []),
  }),
}));

import { Composer } from "./Composer";
import { useChatStore } from "../../stores/chatStore";
import { usePermissionModeStore } from "../../stores/permissionModeStore";

const chord = { key: "π", code: "KeyP", metaKey: true, altKey: true };

beforeEach(() => {
  usePermissionModeStore.setState({ byThread: {} });
  useChatStore.setState({ activeThreadByWs: { w1: "t1" } });
  let stored = "edit";
  modes.getThreadPermissionMode.mockReset().mockImplementation(async () => ({ stored, effective: stored, forced: false }));
  modes.setThreadPermissionMode.mockReset().mockImplementation(async (_t: string, mode: string) => (stored = mode));
});

describe("Composer permission mode", () => {
  it("cycles the mode with ⌘⌥P while the focus is in the Composer, and only there", async () => {
    render(<Composer workspaceId="w1" workspacePath="/ws" />);
    await screen.findByRole("button", { name: "Permission mode: Edit freely" });
    const input = screen.getByRole("combobox");
    input.focus();

    fireEvent.keyDown(input, chord);
    await waitFor(() => expect(modes.setThreadPermissionMode).toHaveBeenCalledWith("t1", "plan"));
    expect(screen.getByRole("button", { name: "Permission mode: Plan only" })).toBeInTheDocument();

    // A held chord, or the chord outside the Composer, does nothing.
    fireEvent.keyDown(input, { ...chord, repeat: true });
    fireEvent.keyDown(document.body, chord);
    // From the mode chip itself, it cycles on.
    fireEvent.keyDown(screen.getByRole("button", { name: "Permission mode: Plan only" }), chord);
    await waitFor(() => expect(modes.setThreadPermissionMode).toHaveBeenCalledTimes(2));
    expect(modes.setThreadPermissionMode).toHaveBeenLastCalledWith("t1", "ask");
  });
});
