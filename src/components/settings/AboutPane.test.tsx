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

import { AboutPane, REFERENCE_LINK_CLASS } from "./AboutPane";
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
    expect(container.querySelector('[data-tour="about-check-updates"]')?.textContent).toMatch(/Look(ing)? for a newer version/);
  });

  it("words the update check as an upright serif phrase in the ghost recipe", () => {
    const { container } = render(<AboutPane />);
    const btn = container.querySelector('[data-tour="about-check-updates"]')!;
    expect(btn).toHaveClass("font-serif", "border-octo-border-strong");
    // An operable control is bounded by the strong border tier, never the hairline (WCAG 1.4.11).
    expect(btn).not.toHaveClass("border-octo-hairline");
    expect(btn).not.toHaveClass("font-mono");
    expect(btn).not.toHaveClass("uppercase");
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

describe("AboutPane — reference links (#560)", () => {
  it("renders both links in sage with an underline that turns ivory on hover, motion-safe", () => {
    const { container } = render(<AboutPane />);
    const repo = screen.getByText("github.com/octopush-sh/octopush");
    const notes = container.querySelector('[data-tour="about-whats-new"]')!;
    for (const el of [repo, notes]) {
      expect(el).toHaveClass(...REFERENCE_LINK_CLASS.split(" "));
      expect(el).toHaveClass("text-octo-sage", "hover:decoration-octo-ivory", "motion-reduce:transition-none");
      expect(el).not.toHaveClass("text-octo-brass");
    }
  });
});
