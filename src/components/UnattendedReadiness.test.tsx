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

import { ipc } from "../lib/ipc";
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

  it("for a Pro user on a sandboxed mission, shows the confirmed state, not the enable button", () => {
    setEntitled(["runs.detached"]);
    useMissionsStore.setState({ missionByWorkspaceId: { w1: mission("sandbox") } });
    render(<UnattendedReadiness workspaceId="w1" />);
    expect(screen.getByText(/sandboxed/i)).toBeInTheDocument();
    expect(screen.queryByText(/sandbox it/i)).not.toBeInTheDocument();
  });
});
