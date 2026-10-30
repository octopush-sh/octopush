import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getUpdateChannel: vi.fn(async () => "stable"),
    setUpdateChannel: vi.fn(async (c: string) => c),
    getSkippedUpdateVersion: vi.fn(async () => null),
    setSkippedUpdateVersion: vi.fn(async () => {}),
    updaterCheck: vi.fn(async () => null),
    updaterInstall: vi.fn(async () => {}),
    openFileInSystem: vi.fn(async () => {}),
  },
}));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));

import { AboutPane } from "./AboutPane";
import { useUpdaterStore } from "../../stores/updaterStore";

const INITIAL = useUpdaterStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useUpdaterStore.setState({ ...INITIAL }, true);
});

describe("AboutPane — update channel", () => {
  it("carries the tour ids", () => {
    const { container } = render(<AboutPane />);
    expect(container.querySelector('[data-tour="about-update-channel"]')).not.toBeNull();
    expect(container.querySelector('[data-tour="about-check-updates"]')?.textContent).toMatch(/Check for updates|Checking/);
  });

  it("shows the persisted channel and switches to beta (which checks)", async () => {
    ipcMock.getUpdateChannel.mockResolvedValueOnce("stable");
    render(<AboutPane />);
    const beta = screen.getByRole("radio", { name: "Beta" });
    expect(screen.getByRole("radio", { name: "Stable" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Beta gets the nightly builds first/)).toBeInTheDocument();
    await waitFor(() => expect(useUpdaterStore.getState().phase).not.toBe("checking"));
    ipcMock.updaterCheck.mockClear();
    fireEvent.click(beta);
    await waitFor(() => expect(ipcMock.setUpdateChannel).toHaveBeenCalledWith("beta"));
    await waitFor(() => expect(ipcMock.updaterCheck).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: "Beta" })).toHaveAttribute("aria-checked", "true");
  });

  it("renders an available update's notes as Markdown", () => {
    useUpdaterStore.setState({
      phase: "available",
      currentVersion: "1.3.0",
      update: { version: "1.4.0", currentVersion: "1.3.0", date: null, body: "## Fixes\n- **Faster**", channel: "beta" },
    });
    render(<AboutPane />);
    expect(screen.getByRole("heading", { name: "Fixes" })).toBeInTheDocument();
    expect(screen.getByText("Faster").tagName).toBe("STRONG");
  });
});
