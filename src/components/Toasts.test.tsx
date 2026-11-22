/**
 * Toasts live in module state, so a toast outlives the `ToastContainer` it
 * was pushed into: the app mounts one container per top-level view (Welcome,
 * New project, the shell) and swaps them when a project opens at launch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { ToastContainer, pushToast, resetToastsForTest } from "./Toasts";
import {
  SETTINGS_NOTICE_MS,
  SETTINGS_NOTICE_TITLE,
  settingsNoticeBody,
} from "../lib/settingsNotice";

/** The app's two top-level branches, each with its own container. */
function Shell({ view }: { view: "welcome" | "project" }) {
  return view === "welcome" ? (
    <div data-testid="welcome">
      <ToastContainer />
    </div>
  ) : (
    <main data-testid="project">
      <ToastContainer />
    </main>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  resetToastsForTest();
});

afterEach(() => {
  resetToastsForTest();
  vi.useRealTimers();
});

describe("ToastContainer", () => {
  it("keeps a toast when the app swaps one container for another", () => {
    const path = "/Users/dev/.octopush/settings.json";
    const { rerender } = render(<Shell view="welcome" />);
    act(() => {
      pushToast({
        level: "error",
        title: SETTINGS_NOTICE_TITLE,
        body: settingsNoticeBody(path),
        timeout: SETTINGS_NOTICE_MS,
      });
    });
    expect(screen.getByTestId("welcome")).toHaveTextContent(SETTINGS_NOTICE_TITLE);

    // Launch restore opens the last project: the Welcome container unmounts
    // and the shell's own container mounts.
    rerender(<Shell view="project" />);
    expect(screen.queryByTestId("welcome")).toBeNull();
    expect(screen.getByTestId("project")).toHaveTextContent(SETTINGS_NOTICE_TITLE);
    expect(screen.getByTestId("project")).toHaveTextContent(path);

    // It still leaves on its own timeout, counted from the push.
    act(() => {
      vi.advanceTimersByTime(SETTINGS_NOTICE_MS - 1);
    });
    expect(screen.getByText(SETTINGS_NOTICE_TITLE)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText(SETTINGS_NOTICE_TITLE)).toBeNull();
  });

  it("shows a toast pushed before any container is mounted", () => {
    pushToast({ level: "info", title: "Pushed early" });
    render(<ToastContainer />);
    expect(screen.getByText("Pushed early")).toBeInTheDocument();
  });

  it("dismisses for good, also after a swap", () => {
    const { rerender } = render(<Shell view="welcome" />);
    act(() => {
      pushToast({ level: "info", title: "Dismiss me", timeout: 60_000 });
    });
    fireEvent.click(screen.getByLabelText("Dismiss notification"));
    expect(screen.queryByText("Dismiss me")).toBeNull();
    rerender(<Shell view="project" />);
    expect(screen.queryByText("Dismiss me")).toBeNull();
  });

  it("lets a long body wrap instead of overflowing", () => {
    render(<ToastContainer />);
    act(() => {
      pushToast({ level: "error", title: "Long", body: "/a/very/long/path/settings.json" });
    });
    expect(screen.getByText("/a/very/long/path/settings.json")).toHaveClass("break-words");
  });
});
