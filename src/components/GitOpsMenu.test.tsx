import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { ipcMock, pushToast } = vi.hoisted(() => ({
  ipcMock: {
    listBranches: vi.fn(),
    switchBranch: vi.fn(),
    createAndSwitchBranch: vi.fn(),
    stashPush: vi.fn(),
    stashList: vi.fn(),
    stashPop: vi.fn(),
    stashDrop: vi.fn(),
    cleanUntracked: vi.fn(),
  },
  pushToast: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("./Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));

import { GitOpsMenu } from "./GitOpsMenu";

function renderMenu(overrides: Partial<Parameters<typeof GitOpsMenu>[0]> = {}) {
  const onChanged = vi.fn();
  render(
    <GitOpsMenu
      projectPath="/repo"
      branch="main"
      dirty={true}
      untrackedCount={2}
      onChanged={onChanged}
      {...overrides}
    />,
  );
  return { onChanged };
}

async function openMenu() {
  await userEvent.click(screen.getByRole("button", { name: /branches & more/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.listBranches.mockResolvedValue({ local: ["main", "side"], remote: [] });
  ipcMock.stashList.mockResolvedValue([]);
});

describe("GitOpsMenu — branches", () => {
  it("opens with the current branch header and the local branch list", async () => {
    renderMenu();
    await openMenu();
    expect(await screen.findByRole("menu", { name: /branches & more/i })).toBeTruthy();
    await waitFor(() => expect(ipcMock.listBranches).toHaveBeenCalledWith("/repo"));
    expect(await screen.findByRole("menuitem", { name: /side/ })).toBeTruthy();
    // Current branch row is marked as current via its tooltip.
    expect(screen.getByTitle(/main — current branch/i)).toBeTruthy();
  });

  it("clicking another branch switches and refreshes", async () => {
    ipcMock.switchBranch.mockResolvedValue("Switched to branch 'side'");
    const { onChanged } = renderMenu();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /side/ }));
    await waitFor(() => expect(ipcMock.switchBranch).toHaveBeenCalledWith("/repo", "side"));
    expect(onChanged).toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "success" }));
  });

  it("clicking the current branch just dismisses — no switch call", async () => {
    const { onChanged } = renderMenu();
    await openMenu();
    await userEvent.click(await screen.findByTitle(/main — current branch/i));
    expect(ipcMock.switchBranch).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a worktree-collision error surfaces as an error toast", async () => {
    ipcMock.switchBranch.mockRejectedValue("'side' is checked out in another workspace");
    renderMenu();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /side/ }));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error", body: expect.stringContaining("another workspace") }),
      ),
    );
  });

  it("Create branch prompts for a name and creates off the current branch", async () => {
    ipcMock.createAndSwitchBranch.mockResolvedValue("");
    const { onChanged } = renderMenu();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /create branch/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /branch name/i }), "feat/fresh");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() =>
      expect(ipcMock.createAndSwitchBranch).toHaveBeenCalledWith("/repo", "feat/fresh", "main"),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("branch names with spaces are rejected inline", async () => {
    renderMenu();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /create branch/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /branch name/i }), "bad name");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot contain spaces/i);
    expect(ipcMock.createAndSwitchBranch).not.toHaveBeenCalled();
  });
});

describe("GitOpsMenu — stash", () => {
  it("Stash changes prompts for a message and pushes", async () => {
    ipcMock.stashPush.mockResolvedValue(undefined);
    const { onChanged } = renderMenu();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /stash changes/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /stash message/i }), "wip: thing");
    await userEvent.click(screen.getByRole("button", { name: /^stash$/i }));
    await waitFor(() => expect(ipcMock.stashPush).toHaveBeenCalledWith("/repo", "wip: thing"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("Stash changes is disabled when the tree is clean", async () => {
    renderMenu({ dirty: false });
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: /stash changes/i })).toBeDisabled();
  });

  it("Stashes browser lists entries; Pop pops; Drop is confirm-gated", async () => {
    ipcMock.stashList.mockResolvedValue([
      { index: 0, message: "On main: newer", timestampMs: Date.now() },
      { index: 1, message: "On main: older", timestampMs: Date.now() - 60_000 },
    ]);
    ipcMock.stashPop.mockResolvedValue(undefined);
    ipcMock.stashDrop.mockResolvedValue(undefined);
    const { onChanged } = renderMenu();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /stashes/i }));

    expect(await screen.findByText("On main: newer")).toBeTruthy();
    expect(screen.getByText("On main: older")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /pop stash 0/i }));
    await waitFor(() => expect(ipcMock.stashPop).toHaveBeenCalledWith("/repo", 0));
    expect(onChanged).toHaveBeenCalled();

    // Drop asks first; the ipc call only fires on confirm.
    await userEvent.click(screen.getByRole("button", { name: /drop stash 1/i }));
    expect(ipcMock.stashDrop).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^drop$/i }));
    await waitFor(() => expect(ipcMock.stashDrop).toHaveBeenCalledWith("/repo", 1));
  });
});

describe("GitOpsMenu — clean untracked", () => {
  it("is confirm-gated and reports the removed count", async () => {
    ipcMock.cleanUntracked.mockResolvedValue(["loose.txt", "junk/"]);
    const { onChanged } = renderMenu({ untrackedCount: 2 });
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /clean untracked/i }));
    // Confirm dialog names the count; nothing removed until confirmed.
    expect(await screen.findByText(/2 untracked files/i)).toBeTruthy();
    expect(ipcMock.cleanUntracked).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^clean$/i }));
    await waitFor(() => expect(ipcMock.cleanUntracked).toHaveBeenCalledWith("/repo"));
    expect(onChanged).toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "success", body: expect.stringContaining("2") }),
    );
  });

  it("is disabled when there is nothing untracked", async () => {
    renderMenu({ untrackedCount: 0 });
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: /clean untracked/i })).toBeDisabled();
  });
});
