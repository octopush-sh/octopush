import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockReveal, mockOpenSystem, mockOpenTerminal, mockPushToast } = vi.hoisted(() => ({
  mockReveal: vi.fn().mockResolvedValue(undefined),
  mockOpenSystem: vi.fn().mockResolvedValue(undefined),
  mockOpenTerminal: vi.fn().mockResolvedValue(undefined),
  mockPushToast: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    revealInFinder: mockReveal,
    openFileInSystem: mockOpenSystem,
    openInTerminal: mockOpenTerminal,
  },
}));

vi.mock("./Toasts", () => ({ pushToast: mockPushToast }));

import { FileTreeContextMenu } from "./FileTreeContextMenu";

const mockWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(navigator, { clipboard: { writeText: mockWriteText } });
});

function renderMenu(overrides: Partial<Parameters<typeof FileTreeContextMenu>[0]> = {}) {
  const onDismiss = vi.fn();
  const onNewFile = vi.fn();
  const onNewDir = vi.fn();
  const onRename = vi.fn();
  const onDelete = vi.fn();
  render(
    <FileTreeContextMenu
      path="/repo/src/Main.java"
      name="Main.java"
      isDir={false}
      rootPath="/repo"
      x={100}
      y={100}
      onDismiss={onDismiss}
      onNewFile={onNewFile}
      onNewDir={onNewDir}
      onRename={onRename}
      onDelete={onDelete}
      {...overrides}
    />,
  );
  return { onDismiss, onNewFile, onNewDir, onRename, onDelete };
}

describe("FileTreeContextMenu", () => {
  it("file target: shows file items, not the folder-only item", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: /reveal in finder/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /open in system app/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /copy path/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /copy relative path/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /open in terminal/i })).not.toBeInTheDocument();
  });

  it("folder target: shows Open in terminal, not Open in system app", () => {
    renderMenu({ path: "/repo/src", name: "src", isDir: true });
    expect(screen.getByRole("menuitem", { name: /open in terminal/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /open in system app/i })).not.toBeInTheDocument();
  });

  it("Reveal in Finder calls ipc and dismisses", async () => {
    const { onDismiss } = renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /reveal in finder/i }));
    expect(mockReveal).toHaveBeenCalledWith("/repo/src/Main.java");
    expect(onDismiss).toHaveBeenCalled();
  });

  it("toasts when Reveal in Finder fails", async () => {
    mockReveal.mockRejectedValueOnce(new Error("gone"));
    renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /reveal in finder/i }));
    await vi.waitFor(() =>
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error", title: "Reveal failed" }),
      ),
    );
  });

  it("Open in system app calls ipc with the file path", async () => {
    renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /open in system app/i }));
    expect(mockOpenSystem).toHaveBeenCalledWith("/repo/src/Main.java");
  });

  it("Copy path writes the absolute path", async () => {
    renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /^copy path$/i }));
    expect(mockWriteText).toHaveBeenCalledWith("/repo/src/Main.java");
  });

  it("Copy relative path strips the root prefix", async () => {
    renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /copy relative path/i }));
    expect(mockWriteText).toHaveBeenCalledWith("src/Main.java");
  });

  it("renders into document.body (portal) with fixed positioning", () => {
    const onDismiss = vi.fn();
    const noop = vi.fn();
    const { container } = render(
      <div style={{ overflow: "hidden" }}>
        <FileTreeContextMenu
          path="/repo/a.txt"
          name="a.txt"
          isDir={false}
          rootPath="/repo"
          x={10}
          y={10}
          onDismiss={onDismiss}
          onNewFile={noop}
          onNewDir={noop}
          onRename={noop}
          onDelete={noop}
        />
      </div>,
    );
    const menu = screen.getByRole("menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.className).toContain("fixed");
  });

  // ─── File operations section (G6 slice II) ─────────────────────

  it("folder target: shows New file, New folder, Rename, and Delete", () => {
    renderMenu({ path: "/repo/src", name: "src", isDir: true });
    expect(screen.getByRole("menuitem", { name: /new file/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /new folder/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("file target: shows Rename and Delete but not the create items", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /new file/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /new folder/i })).not.toBeInTheDocument();
  });

  it("New file invokes onNewFile and dismisses", async () => {
    const { onNewFile, onDismiss } = renderMenu({ path: "/repo/src", name: "src", isDir: true });
    await userEvent.click(screen.getByRole("menuitem", { name: /new file/i }));
    expect(onNewFile).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("New folder invokes onNewDir and dismisses", async () => {
    const { onNewDir, onDismiss } = renderMenu({ path: "/repo/src", name: "src", isDir: true });
    await userEvent.click(screen.getByRole("menuitem", { name: /new folder/i }));
    expect(onNewDir).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("Rename invokes onRename and dismisses", async () => {
    const { onRename, onDismiss } = renderMenu();
    await userEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("root target: keeps New file/New folder but hides Rename and Delete", () => {
    renderMenu({ path: "/repo", name: "repo", isDir: true, isRoot: true });
    expect(screen.getByRole("menuitem", { name: /new file/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /new folder/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("Delete invokes onDelete, dismisses, and is rouge-styled", async () => {
    const { onDelete, onDismiss } = renderMenu();
    const item = screen.getByRole("menuitem", { name: /delete/i });
    expect(item.className).toContain("text-octo-rouge");
    await userEvent.click(item);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalled();
  });
});
