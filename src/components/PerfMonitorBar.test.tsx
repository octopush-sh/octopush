import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PerfMonitorBar } from "./PerfMonitorBar";
import { usePerfStore } from "../stores/perfStore";

beforeEach(() => {
  usePerfStore.setState({ stats: null });
});

describe("PerfMonitorBar", () => {
  it("shows a measuring state before any sample", () => {
    render(<PerfMonitorBar />);
    expect(screen.getByText(/measuring/i)).toBeInTheDocument();
  });

  it("shows the total RAM + CPU once stats arrive", () => {
    usePerfStore.setState({
      stats: {
        app: { rssBytes: 318 * 1024 * 1024, cpuPct: 4, processCount: 5 },
        daemon: { rssBytes: 94 * 1024 * 1024, cpuPct: 2, processCount: 1 },
        total: { rssBytes: 412 * 1024 * 1024, cpuPct: 6, processCount: 6 },
        ts: 1,
      },
    });
    render(<PerfMonitorBar />);
    expect(screen.getByText("412 MB")).toBeInTheDocument();
    expect(screen.getByText("6%")).toBeInTheDocument();
  });

  it("toggles the per-group popover on click", () => {
    usePerfStore.setState({
      stats: {
        app: { rssBytes: 318 * 1024 * 1024, cpuPct: 4, processCount: 5 },
        daemon: { rssBytes: 94 * 1024 * 1024, cpuPct: 2, processCount: 1 },
        total: { rssBytes: 412 * 1024 * 1024, cpuPct: 6, processCount: 6 },
        ts: 1,
      },
    });
    render(<PerfMonitorBar />);
    expect(screen.queryByText("App")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /performance/i }));
    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("Daemon")).toBeInTheDocument();
    expect(screen.getByText("318 MB")).toBeInTheDocument();
  });
});
