import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    setSkippedUpdateVersion: vi.fn(async () => {}),
    updaterInstall: vi.fn(async () => {}),
    openFileInSystem: vi.fn(async () => {}),
  },
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));

import { UpdateAlert, formatReleaseDate } from "./UpdateAlert";
import { useUpdaterStore } from "../stores/updaterStore";

const INITIAL = useUpdaterStore.getState();
const UPDATE = { version: "1.4.0", currentVersion: "1.3.0", date: "2026-10-30T12:00:00Z", body: "## Features\n- New", channel: "stable" as const };

beforeEach(() => {
  vi.clearAllMocks();
  useUpdaterStore.setState({ ...INITIAL, phase: "available", update: UPDATE, alertOpen: true }, true);
});

describe("UpdateAlert", () => {
  it("shows version, date and rendered notes", () => {
    render(<UpdateAlert />);
    expect(screen.getByRole("dialog", { name: "Update available" })).toBeInTheDocument();
    expect(screen.getByText("Octopush 1.4.0 is ready.")).toBeInTheDocument();
    expect(screen.getByText(/October 30, 2026/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Features" })).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    useUpdaterStore.setState({ alertOpen: false });
    render(<UpdateAlert />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Later and Skip this version close it; skip persists", () => {
    render(<UpdateAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Skip this version" }));
    expect(ipcMock.setSkippedUpdateVersion).toHaveBeenCalledWith("1.4.0");
    expect(useUpdaterStore.getState().alertOpen).toBe(false);
  });

  it("Install and relaunch starts the install", () => {
    render(<UpdateAlert />);
    fireEvent.click(screen.getByRole("button", { name: /Install and relaunch/ }));
    expect(ipcMock.updaterInstall).toHaveBeenCalled();
  });

  it("formatReleaseDate tolerates missing or bad dates", () => {
    expect(formatReleaseDate(null)).toBeNull();
    expect(formatReleaseDate("nope")).toBeNull();
  });
});
