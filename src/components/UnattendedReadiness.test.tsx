import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UnattendedReadiness } from "./UnattendedReadiness";
import { useEntitlementStore } from "../stores/entitlementStore";
import { useMissionsStore } from "../stores/missionsStore";
import { useUpgradeStore } from "../stores/upgradeStore";
import type { Mission } from "../lib/types";

vi.mock("../lib/ipc", () => ({
  ipc: {
    updateMission: vi.fn(),
    listMissions: vi.fn(),
  },
}));

vi.mock("./Toasts", () => ({ pushToast: vi.fn() }));

import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
const updateMissionMock = vi.mocked(ipc.updateMission);
const listMissionsMock = vi.mocked(ipc.listMissions);

function mission(execIsolation: string): Mission {
  return {
    id: "m1",
    workspaceId: "w1",
    projectId: "p1",
    intent: "build",
    title: "t",
    status: "active",
    linkedIssueKey: null,
    gitIsolation: "worktree",
    execIsolation,
    payload: "",
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
  };
}

function setEntitled(features: string[]) {
  useEntitlementStore.setState({
    entitlement: { plan: features.length ? "pro" : "free", features, directRunsPerMonth: null },
    loaded: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listMissionsMock.mockResolvedValue([]);
  updateMissionMock.mockResolvedValue(mission("sandbox"));
  useUpgradeStore.setState({ info: null });
  useMissionsStore.setState({ missionByWorkspaceId: { w1: mission("none") } });
});

describe("UnattendedReadiness", () => {
  it("shows a locked Pro chip for a free user and opens the runs.detached upsell", () => {
    setEntitled([]);
    render(<UnattendedReadiness workspaceId="w1" />);
    const chip = screen.getByText(/Unattended · Pro/i);
    fireEvent.click(chip);
    expect(useUpgradeStore.getState().info?.feature).toBe("runs.detached");
  });

  it("for a Pro user on an unsandboxed mission, offers a one-click sandbox enable", async () => {
    setEntitled(["runs.detached"]);
    useMissionsStore.setState({ missionByWorkspaceId: { w1: mission("none") } });
    render(<UnattendedReadiness workspaceId="w1" />);
    expect(screen.getByText(/Runs unattended/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/sandbox it/i));
    await waitFor(() =>
      expect(updateMissionMock).toHaveBeenCalledWith("m1", null, null, null, "sandbox"),
    );
  });

  it("says so when turning the sandbox on removed a link to the main checkout", async () => {
    setEntitled([]);
    updateMissionMock.mockResolvedValue({ ...mission("sandbox"), unlinked: ["node_modules"] });
    render(<UnattendedReadiness workspaceId="w1" />);
    fireEvent.click(screen.getByText(/sandbox it/i));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    expect(vi.mocked(pushToast).mock.calls[0][0]).toMatchObject({
      level: "success",
      title: "Sandbox enabled",
      body: expect.stringContaining("Removed the link to the main checkout's node_modules"),
    });
  });

  it("says which copied env files turning the sandbox on removed or kept", async () => {
    setEntitled([]);
    updateMissionMock.mockResolvedValue({ ...mission("sandbox"), unlinked: [], uncopied: [".env"], keptCopies: [".env.local"] });
    render(<UnattendedReadiness workspaceId="w1" />);
    fireEvent.click(screen.getByText(/sandbox it/i));
    await waitFor(() => expect(pushToast).toHaveBeenCalled());
    const body = String(vi.mocked(pushToast).mock.calls[0][0].body);
    expect(body).toContain("Removed the copied .env from this mission's worktree.");
    expect(body).toContain(".env.local was changed in this mission, so it stays");
  });

  it("for a Pro user on a sandboxed mission, shows the confirmed state, not the enable button", () => {
    setEntitled(["runs.detached"]);
    useMissionsStore.setState({ missionByWorkspaceId: { w1: mission("sandbox") } });
    render(<UnattendedReadiness workspaceId="w1" />);
    expect(screen.getByText(/^sandboxed$/i)).toBeInTheDocument();
    expect(screen.queryByText(/sandbox it/i)).not.toBeInTheDocument();
  });

  it("a FREE user still gets the sandbox toggle (sandbox is free) alongside the Pro chip", () => {
    setEntitled([]);
    useMissionsStore.setState({ missionByWorkspaceId: { w1: mission("none") } });
    render(<UnattendedReadiness workspaceId="w1" />);
    expect(screen.getByText(/Unattended · Pro/i)).toBeInTheDocument();
    expect(screen.getByText(/sandbox it/i)).toBeInTheDocument(); // sandbox is not gated
  });

  it("a sandboxed mission can be turned OFF (the escape valve for a build that needs to write out)", async () => {
    setEntitled([]);
    useMissionsStore.setState({ missionByWorkspaceId: { w1: mission("sandbox") } });
    render(<UnattendedReadiness workspaceId="w1" />);
    fireEvent.click(screen.getByText(/^sandboxed$/i));
    // It asks first, as the header's Shield does (#1230).
    expect(screen.getByRole("dialog", { name: "Turn off the sandbox" })).toBeInTheDocument();
    expect(updateMissionMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Let its agents write outside the workspace" }));
    await waitFor(() =>
      expect(updateMissionMock).toHaveBeenCalledWith("m1", null, null, null, "none"),
    );
  });

  it("keeping the sandbox from the launcher changes nothing", () => {
    setEntitled([]);
    useMissionsStore.setState({ missionByWorkspaceId: { w1: mission("sandbox") } });
    render(<UnattendedReadiness workspaceId="w1" />);
    fireEvent.click(screen.getByText(/^sandboxed$/i));
    fireEvent.click(screen.getByRole("button", { name: "Keep the sandbox" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(updateMissionMock).not.toHaveBeenCalled();
  });
});
