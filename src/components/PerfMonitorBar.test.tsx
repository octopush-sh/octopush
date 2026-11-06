import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { PerfMonitorBar } from "./PerfMonitorBar";
import { usePerfStore } from "../stores/perfStore";

// Mock the ipc module so getWorkspaceCacheSizes doesn't call Tauri.
vi.mock("../lib/ipc", () => ({
  ipc: {
    getWorkspaceCacheSizes: vi.fn(),
  },
}));

import { ipc } from "../lib/ipc";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIpc = ipc as unknown as { getWorkspaceCacheSizes: ReturnType<typeof vi.fn> };

const DISK_FIXTURE = {
  disk: { freeBytes: 18 * 1024 * 1024 * 1024, totalBytes: 460 * 1024 * 1024 * 1024 },
};

const STATS_FIXTURE = {
  app: { rssBytes: 318 * 1024 * 1024, cpuPct: 4, processCount: 5 },
  daemon: { rssBytes: 94 * 1024 * 1024, cpuPct: 2, processCount: 1 },
  total: { rssBytes: 412 * 1024 * 1024, cpuPct: 6, processCount: 6 },
  ...DISK_FIXTURE,
  ts: 1,
};

beforeEach(() => {
  usePerfStore.setState({ stats: null, detailsOpen: false });
  vi.clearAllMocks();
});

describe("PerfMonitorBar", () => {
  it("shows a measuring state before any sample", () => {
    render(<PerfMonitorBar />);
    expect(screen.getByText(/measuring/i)).toBeInTheDocument();
  });

  it("shows the total RAM + CPU once stats arrive", () => {
    usePerfStore.setState({ stats: STATS_FIXTURE });
    render(<PerfMonitorBar />);
    expect(screen.getByText("412 MB")).toBeInTheDocument();
    expect(screen.getByText("6%")).toBeInTheDocument();
  });

  it("shows disk free in the bar", () => {
    usePerfStore.setState({ stats: STATS_FIXTURE });
    render(<PerfMonitorBar />);
    expect(screen.getByText("18 GB")).toBeInTheDocument();
  });

  it("toggles the per-group popover on click", () => {
    usePerfStore.setState({ stats: STATS_FIXTURE });
    render(<PerfMonitorBar />);
    expect(screen.queryByText("App")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /performance/i }));
    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("Daemon")).toBeInTheDocument();
    expect(screen.getByText("318 MB")).toBeInTheDocument();
  });

  it("opens from the store, as the Readiness card's disk row does", () => {
    usePerfStore.setState({ stats: STATS_FIXTURE });
    render(<PerfMonitorBar />);
    expect(screen.queryByText("Workspace Caches")).not.toBeInTheDocument();
    act(() => usePerfStore.getState().setDetailsOpen(true));
    expect(screen.getByText("Workspace Caches")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /performance/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows a quiet dash in caches when there is no workspace path", () => {
    usePerfStore.setState({ stats: STATS_FIXTURE });
    render(<PerfMonitorBar />);
    fireEvent.click(screen.getByRole("button", { name: /performance/i }));
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("fetches and lists workspace caches when the popover opens", async () => {
    mockIpc.getWorkspaceCacheSizes.mockResolvedValue({
      entries: [{ name: "target", bytes: 34 * 1024 * 1024 * 1024 }],
      totalBytes: 34 * 1024 * 1024 * 1024,
    });
    usePerfStore.setState({ stats: STATS_FIXTURE });
    render(<PerfMonitorBar workspacePath="/repo/ws" />);
    fireEvent.click(screen.getByRole("button", { name: /performance/i }));
    expect(await screen.findByText("target")).toBeInTheDocument();
    // "34 GB" appears twice: once for the entry, once for the total row.
    expect(screen.getAllByText("34 GB").length).toBeGreaterThanOrEqual(1);
    expect(mockIpc.getWorkspaceCacheSizes).toHaveBeenCalledWith("/repo/ws");
  });
});
