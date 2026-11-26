/**
 * Settings › General › Attention — "Notify me elsewhere" (#964): off by
 * default, the URL saved through the backend's validation, the switch only
 * with a URL, "Send a test", and a read-only preview of the exact body.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

const getNotifyElsewhere = vi.fn();
const setNotifyElsewhere = vi.fn();
const notifyElsewhereTest = vi.fn();
const notifyElsewherePreview = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getNotifyElsewhere: (...args: unknown[]) => getNotifyElsewhere(...args),
    setNotifyElsewhere: (...args: unknown[]) => setNotifyElsewhere(...args),
    notifyElsewhereTest: (...args: unknown[]) => notifyElsewhereTest(...args),
    notifyElsewherePreview: (...args: unknown[]) => notifyElsewherePreview(...args),
  },
}));

import {
  NotifyElsewhereRow,
  NOTIFY_LABEL,
  NOTIFY_HELP,
  NOTIFY_URL_PLACEHOLDER,
  notifyErrorText,
} from "./NotifyElsewhereRow";

/** What the backend's `notify_elsewhere::preview()` answers. */
const TEXT = "Octopush · Checkpoint gate waiting · Example mission · Example project";
const PREVIEW = {
  payload: {
    text: TEXT,
    content: TEXT,
    mission: "Example mission",
    project: "Example project",
    event: "checkpoint_gate",
  },
  events: [
    { event: "checkpoint_gate", label: "Checkpoint gate waiting" },
    { event: "director_question", label: "Question waiting for you" },
    { event: "plan_limit", label: "Claude plan limit, waiting for you" },
    { event: "run_failed", label: "Crew run failed" },
    { event: "routine_finished", label: "Routine finished" },
    { event: "routine_failed", label: "Routine failed" },
    { event: "test", label: "Test message" },
  ],
};

const HOOK = "https://hooks.example.com/services/T0/B0/crew";

beforeEach(() => {
  getNotifyElsewhere.mockReset().mockResolvedValue({ enabled: false, url: "" });
  setNotifyElsewhere
    .mockReset()
    .mockImplementation((enabled: boolean, url: string) => Promise.resolve({ enabled, url }));
  notifyElsewhereTest.mockReset().mockResolvedValue(undefined);
  notifyElsewherePreview.mockReset().mockResolvedValue(PREVIEW);
});

async function renderRow() {
  await act(async () => {
    render(<NotifyElsewhereRow />);
  });
}

const toggle = () => screen.getByTestId("notify-elsewhere-switch");
const field = () => screen.getByTestId("notify-elsewhere-url") as HTMLInputElement;
const testButton = () => screen.getByTestId("notify-elsewhere-test");

describe("NotifyElsewhereRow — off by default", () => {
  it("is off with no URL, and the switch waits for one", async () => {
    await renderRow();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(toggle()).toBeDisabled();
    expect(toggle()).toHaveAttribute("title", "Add a webhook URL first");
    expect(toggle()).toHaveAccessibleName(NOTIFY_LABEL);
    expect(field().value).toBe("");
    expect(testButton()).toBeDisabled();
    expect(setNotifyElsewhere).not.toHaveBeenCalled();
    expect(notifyElsewhereTest).not.toHaveBeenCalled();
  });

  it("says what it sends and what it never sends", async () => {
    await renderRow();
    expect(screen.getByText(NOTIFY_HELP)).toBeInTheDocument();
    expect(NOTIFY_HELP).toContain(
      "It carries a fixed label, the project's name and the mission's title (the start of its task), never code, diffs, questions or agent output. Off until you turn it on; Send a test posts one test message either way.",
    );
    expect(NOTIFY_HELP).toContain("a Slack or Discord incoming webhook, or any endpoint that accepts JSON");
    expect(NOTIFY_HELP).not.toContain("ntfy");
    expect(field()).toHaveAttribute("placeholder", NOTIFY_URL_PLACEHOLDER);
    expect(NOTIFY_URL_PLACEHOLDER).toBe("https://hooks.example.com/…");
    expect(document.querySelector('[data-tour="settings-notify-elsewhere"]')).not.toBeNull();
  });

  it("shows a saved state as saved", async () => {
    getNotifyElsewhere.mockResolvedValue({ enabled: true, url: HOOK });
    await renderRow();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    expect(field().value).toBe(HOOK);
    expect(toggle()).not.toBeDisabled();
  });
});

describe("NotifyElsewhereRow — saving", () => {
  it("saves the URL on blur, then turns on and off through the backend", async () => {
    await renderRow();
    fireEvent.change(field(), { target: { value: `  ${HOOK}  ` } });
    await act(async () => {
      fireEvent.blur(field());
    });
    await waitFor(() => expect(setNotifyElsewhere).toHaveBeenLastCalledWith(false, HOOK));
    expect(toggle()).toHaveAttribute("aria-checked", "false");
    expect(toggle()).not.toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("notify-elsewhere-saved")).toHaveTextContent("Saved"));

    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(setNotifyElsewhere).toHaveBeenLastCalledWith(true, HOOK));
    expect(toggle()).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(setNotifyElsewhere).toHaveBeenLastCalledWith(false, HOOK));
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("turns on in one click right after a URL is typed", async () => {
    // Real browsers blur the field on the press, so the URL saves first and
    // the switch's save runs after it, never dropped.
    let release: () => void = () => {};
    setNotifyElsewhere.mockImplementationOnce(
      (enabled: boolean, url: string) =>
        new Promise((resolve) => {
          release = () => resolve({ enabled, url });
        }),
    );
    await renderRow();
    fireEvent.change(field(), { target: { value: HOOK } });
    await act(async () => {
      fireEvent.blur(field());
      fireEvent.click(toggle());
    });
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    await act(async () => {
      release();
    });
    await waitFor(() => expect(setNotifyElsewhere).toHaveBeenCalledTimes(2));
    expect(setNotifyElsewhere.mock.calls).toEqual([
      [false, HOOK],
      [true, HOOK],
    ]);
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
  });

  it("a refused switch goes back to what is stored", async () => {
    getNotifyElsewhere.mockResolvedValue({ enabled: false, url: HOOK });
    setNotifyElsewhere.mockRejectedValue("other: Your change wasn't saved: settings.json couldn't be read.");
    await renderRow();
    await waitFor(() => expect(toggle()).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(toggle());
    });
    await waitFor(() => expect(screen.getByTestId("notify-elsewhere-error")).toBeInTheDocument());
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("saves on Enter, and an unchanged URL saves nothing", async () => {
    getNotifyElsewhere.mockResolvedValue({ enabled: true, url: HOOK });
    await renderRow();
    await waitFor(() => expect(field().value).toBe(HOOK));
    await act(async () => {
      fireEvent.blur(field());
    });
    expect(setNotifyElsewhere).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: "https://hooks.example.com/other" } });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    await waitFor(() => expect(setNotifyElsewhere).toHaveBeenLastCalledWith(true, "https://hooks.example.com/other"));
  });

  it("clearing the URL turns it off", async () => {
    getNotifyElsewhere.mockResolvedValue({ enabled: true, url: HOOK });
    await renderRow();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    fireEvent.change(field(), { target: { value: "" } });
    await act(async () => {
      fireEvent.blur(field());
    });
    await waitFor(() => expect(setNotifyElsewhere).toHaveBeenLastCalledWith(false, ""));
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"));
  });

  it("shows the backend's refusal and keeps the saved state", async () => {
    getNotifyElsewhere.mockResolvedValue({ enabled: true, url: HOOK });
    setNotifyElsewhere.mockRejectedValue(
      "other: Use an https:// URL. Plain http:// works only to this Mac (localhost or 127.0.0.1).",
    );
    await renderRow();
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "true"));
    fireEvent.change(field(), { target: { value: "http://example.com/hook" } });
    await act(async () => {
      fireEvent.blur(field());
    });
    await waitFor(() => expect(screen.getByTestId("notify-elsewhere-error")).toBeInTheDocument());
    expect(screen.getByTestId("notify-elsewhere-error")).toHaveTextContent(
      "Use an https:// URL. Plain http:// works only to this Mac (localhost or 127.0.0.1).",
    );
    expect(screen.getByTestId("notify-elsewhere-error").textContent).not.toMatch(/^other:/);
    expect(toggle()).toHaveAttribute("aria-checked", "true");
  });
});

describe("NotifyElsewhereRow — Send a test", () => {
  it("posts the test message to the URL in the field and says it went", async () => {
    await renderRow();
    fireEvent.change(field(), { target: { value: HOOK } });
    expect(testButton()).not.toBeDisabled();
    expect(testButton()).toHaveTextContent("Send a test");
    await act(async () => {
      fireEvent.click(testButton());
    });
    expect(notifyElsewhereTest).toHaveBeenCalledWith(HOOK);
    expect(screen.getByTestId("notify-elsewhere-test-result")).toHaveTextContent("Test sent.");
  });

  it("says why a test didn't send, without the URL", async () => {
    notifyElsewhereTest.mockRejectedValue("other: the webhook answered HTTP 404");
    await renderRow();
    fireEvent.change(field(), { target: { value: HOOK } });
    await act(async () => {
      fireEvent.click(testButton());
    });
    const result = screen.getByTestId("notify-elsewhere-test-result");
    expect(result).toHaveTextContent("The test didn't send: the webhook answered HTTP 404.");
    expect(result.textContent).not.toContain(HOOK);
  });

  it("reads Sending… while the test is in flight", async () => {
    let finish: () => void = () => {};
    notifyElsewhereTest.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    await renderRow();
    fireEvent.change(field(), { target: { value: HOOK } });
    await act(async () => {
      fireEvent.click(testButton());
    });
    expect(testButton()).toHaveTextContent("Sending…");
    expect(testButton()).toBeDisabled();
    await act(async () => {
      finish();
    });
    expect(testButton()).toHaveTextContent("Send a test");
  });
});

describe("NotifyElsewhereRow — the payload preview", () => {
  it("shows the backend's exact body, folded until asked", async () => {
    await renderRow();
    const toggleButton = screen.getByTestId("notify-elsewhere-payload-toggle");
    expect(toggleButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute("aria-expanded", "true");
    const pre = screen.getByTestId("notify-elsewhere-payload");
    const shown = JSON.parse(pre.textContent ?? "");
    expect(shown).toEqual(PREVIEW.payload);
    expect(Object.keys(shown)).toEqual(["text", "content", "mission", "project", "event"]);
    expect(toggleButton).toHaveTextContent("The message's fields");
    expect(screen.getByTestId("notify-elsewhere-events")).toHaveTextContent(
      "checkpoint_gate, director_question, plan_limit, run_failed, routine_finished, routine_failed, test",
    );
  });

  it("is read-only: no field inside it", async () => {
    await renderRow();
    fireEvent.click(screen.getByTestId("notify-elsewhere-payload-toggle"));
    const pre = screen.getByTestId("notify-elsewhere-payload");
    expect(pre.tagName).toBe("PRE");
    expect(pre.querySelector("input, textarea, [contenteditable]")).toBeNull();
  });

  it("stays out of the way when the preview can't be read", async () => {
    notifyElsewherePreview.mockRejectedValue(new Error("no"));
    await renderRow();
    expect(screen.queryByTestId("notify-elsewhere-payload-toggle")).toBeNull();
    expect(toggle()).toBeInTheDocument();
  });
});

describe("notifyErrorText", () => {
  it("drops the AppError prefix", () => {
    expect(notifyErrorText("other: Add a webhook URL first.")).toBe("Add a webhook URL first.");
    expect(notifyErrorText(new Error("other: x"))).toBe("x");
    expect(notifyErrorText("plain")).toBe("plain");
  });
});
