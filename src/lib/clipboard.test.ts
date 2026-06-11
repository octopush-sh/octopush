import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pushToast = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));

import { copyToClipboard } from "./clipboard";

const originalClipboard = navigator.clipboard;

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
  pushToast.mockClear();
});

afterEach(() => {
  setClipboard(originalClipboard);
});

describe("copyToClipboard", () => {
  it("writes the text and pushes a success toast with the given title", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const ok = await copyToClipboard("/tmp/path", "Path copied");

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("/tmp/path");
    expect(pushToast).toHaveBeenCalledWith({ level: "success", title: "Path copied" });
  });

  it("stays silent on success when no title is given (inline-feedback callers)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });

    const ok = await copyToClipboard("text");

    expect(ok).toBe(true);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("pushes an error toast when writeText rejects", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });

    const ok = await copyToClipboard("text", "Copied");

    expect(ok).toBe(false);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Copy failed" }),
    );
  });

  it("pushes an error toast when navigator.clipboard is missing", async () => {
    setClipboard(undefined);

    const ok = await copyToClipboard("text", "Copied");

    expect(ok).toBe(false);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Copy failed" }),
    );
  });
});
