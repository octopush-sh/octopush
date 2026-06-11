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
  render(
    <FileTreeContextMenu
      path="/repo/src/Main.java"
      name="Main.java"
      isDir={false}
      rootPath="/repo"
      x={100}
      y={100}
      onDismiss={onDismiss}
      {...overrides}
    />,
  );
  return { onDismiss };
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
        />
      </div>,
    );
    const menu = screen.getByRole("menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.className).toContain("fixed");
  });
});
