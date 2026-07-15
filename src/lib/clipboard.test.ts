import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pushToast = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));

const tauriWriteText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (t: string) => tauriWriteText(t),
}));

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

describe("copyToClipboard — native Tauri path", () => {
  // Inside the app `inTauri()` is true and we must write via the native plugin,
  // NOT navigator.clipboard (which throws NotAllowedError in WKWebView). jsdom
  // has no __TAURI_INTERNALS__, so simulate the Tauri context here.
  beforeEach(() => {
    tauriWriteText.mockReset();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("writes via the native plugin, never navigator.clipboard, inside Tauri", async () => {
    tauriWriteText.mockResolvedValue(undefined);
    const webWrite = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText: webWrite });

    const ok = await copyToClipboard("pr-body", "Copied");

    expect(ok).toBe(true);
    expect(tauriWriteText).toHaveBeenCalledWith("pr-body");
    expect(webWrite).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith({ level: "success", title: "Copied" });
  });

  it("surfaces an error toast when the native write fails", async () => {
    tauriWriteText.mockRejectedValue(new Error("native denied"));

    const ok = await copyToClipboard("text", "Copied");

    expect(ok).toBe(false);
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", title: "Copy failed" }),
    );
  });
});
