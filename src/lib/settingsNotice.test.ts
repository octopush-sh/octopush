import { describe, it, expect, vi, beforeEach } from "vitest";

const pushToast = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));

const unreadableSettingsPath = vi.fn();
vi.mock("./ipc", () => ({
  ipc: { unreadableSettingsPath: () => unreadableSettingsPath() },
}));

import { noticeUnreadableSettings, SETTINGS_NOTICE_MS } from "./settingsNotice";

beforeEach(() => {
  pushToast.mockClear();
  unreadableSettingsPath.mockReset();
});

describe("noticeUnreadableSettings", () => {
  it("names the file when settings.json can't be parsed", async () => {
    unreadableSettingsPath.mockResolvedValue("/Users/dev/.octopush/settings.json");
    await noticeUnreadableSettings();
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith({
      level: "error",
      title: "settings.json couldn't be read",
      body: "Octopush is showing default settings and won't save changes until /Users/dev/.octopush/settings.json is fixed. The file was left unchanged.",
      timeout: SETTINGS_NOTICE_MS,
    });
  });

  it("stays silent when the file is readable or missing", async () => {
    unreadableSettingsPath.mockResolvedValue(null);
    await noticeUnreadableSettings();
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("stays silent when the check itself fails", async () => {
    unreadableSettingsPath.mockRejectedValue(new Error("no backend"));
    await noticeUnreadableSettings();
    expect(pushToast).not.toHaveBeenCalled();
  });
});
