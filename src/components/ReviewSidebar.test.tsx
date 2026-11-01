import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { changesFocusSpy } = vi.hoisted(() => ({ changesFocusSpy: vi.fn() }));

// Stub the heavy panels — we only test the sidebar's tab + collapse logic.
// Each stub echoes the injected headerLeading so the tab switcher is reachable;
// the ChangesPanel stub registers a focuser so we can exercise the `c` shortcut.
const treeLocateSpy = vi.fn();
vi.mock("./ChangesPanel", () => ({
  ChangesPanel: ({
    headerLeading,
    registerFocusCommit,
  }: {
    headerLeading?: React.ReactNode;
    registerFocusCommit?: (fn: () => void) => void;
  }) => {
    registerFocusCommit?.(changesFocusSpy);
    return <div data-testid="changes-panel">{headerLeading}</div>;
  },
}));
vi.mock("./CompanionFileTree", () => ({
  CompanionFileTree: ({
    headerLeading,
    registerLocate,
  }: {
    headerLeading?: React.ReactNode;
    registerLocate?: (fn: (p: string) => void) => void;
  }) => {
    registerLocate?.(treeLocateSpy);
    return <div data-testid="files-tree">{headerLeading}</div>;
  },
}));

import { ReviewSidebar } from "./ReviewSidebar";

const baseProps = {
  projectPath: "/repo",
  workspaceId: "w1",
  diff: "",
  fileTree: { rootPath: "/repo", rootLabel: "repo", changedPaths: new Set<string>() },
};

beforeEach(() => {
  localStorage.clear();
  changesFocusSpy.mockClear();
  treeLocateSpy.mockClear();
});

describe("ReviewSidebar", () => {
  it("defaults to the Changes tab when there are changes", () => {
    render(<ReviewSidebar changedCount={3} {...baseProps} />);
    expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("files-tree")).not.toBeInTheDocument();
  });

  it("defaults to the Files tab when nothing has changed", () => {
    render(<ReviewSidebar changedCount={0} {...baseProps} />);
    expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    expect(screen.queryByTestId("changes-panel")).not.toBeInTheDocument();
  });

  it("switches to Files when the Files tab is clicked", async () => {
    render(<ReviewSidebar changedCount={3} {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(await screen.findByTestId("files-tree")).toBeInTheDocument();
    // Persisted so a remount keeps the choice.
    expect(localStorage.getItem("reviewSidebarTab")).toBe("files");
  });

  it("the tab switcher shrinks inside a narrow sidebar instead of painting into the canvas", () => {
    // Visual audit #316: at 1024px the sidebar is squeezed below its content
    // width and the Changes|Files buttons drew over the canvas's Diff|Editor
    // toggle. Every level must be shrinkable and the labels must truncate.
    render(<ReviewSidebar changedCount={3} {...baseProps} />);
    const changes = screen.getByRole("button", { name: /changes/i, pressed: true });
    const files = screen.getByRole("button", { name: "Files" });
    for (const btn of [changes, files]) {
      expect(btn).toHaveClass("min-w-0", "[&>svg]:shrink-0");
      expect(btn).toHaveAttribute("title");
      const label = btn.querySelector("span.truncate");
      expect(label).not.toBeNull();
      expect(label).toHaveClass("min-w-0");
    }
    const group = changes.parentElement!;
    expect(group).toHaveClass("min-w-0", "overflow-hidden");
    expect(group.parentElement).toHaveClass("min-w-0");
    expect(screen.getByRole("button", { name: /collapse changes & files/i })).toHaveClass("shrink-0");
  });

  it("collapses to a slim strip and a strip icon re-expands to that tab", async () => {
    render(<ReviewSidebar changedCount={2} {...baseProps} />);
    await userEvent.click(screen.getByRole("button", { name: /collapse changes & files/i }));

    // Panels are gone; the expand control + strip mode icons remain.
    expect(screen.queryByTestId("changes-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand changes & files/i })).toBeInTheDocument();

    // Clicking the Files strip icon expands straight into the Files tab.
    await userEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(await screen.findByTestId("files-tree")).toBeInTheDocument();
    expect(localStorage.getItem("reviewSidebarCollapsed")).toBe("0");
  });

  it("the focus-commit shortcut reveals the Changes tab and focuses the commit box", async () => {
    let focusCommit: (() => void) | undefined;
    render(
      <ReviewSidebar
        changedCount={0}
        {...baseProps}
        registerFocusCommit={(fn) => { focusCommit = fn; }}
      />,
    );
    // changedCount 0 → starts on Files, so ChangesPanel is not mounted.
    expect(screen.queryByTestId("changes-panel")).not.toBeInTheDocument();

    // Fire the shortcut: it must switch to Changes and focus the commit box.
    act(() => focusCommit?.());
    expect(await screen.findByTestId("changes-panel")).toBeInTheDocument();
    expect(changesFocusSpy).toHaveBeenCalled();
  });

  it("reveal from the Changes tab opens Files and replays the request", async () => {
    // The blocking regression: the tree is only mounted on the Files tab, and
    // Review defaults to Changes whenever there are changes — which is exactly
    // when a reviewer asks "where is this file".
    let reveal: ((p: string) => void) | null = null;
    render(
      <ReviewSidebar
        changedCount={3}
        {...baseProps}
        fileTree={{ ...baseProps.fileTree, registerLocate: (fn) => { reveal = fn; } }}
      />,
    );
    expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
    expect(treeLocateSpy).not.toHaveBeenCalled();

    await act(async () => reveal!("/repo/src/App.tsx"));

    // FadeSwap holds the outgoing panel for its 120ms exit before the tree
    // mounts and registers — the replay lands then, not synchronously.
    await screen.findByTestId("files-tree");
    await waitFor(() => expect(treeLocateSpy).toHaveBeenCalledWith("/repo/src/App.tsx"));
  });

  it("reveal from a collapsed sidebar expands it and replays the request", async () => {
    localStorage.setItem("reviewSidebarCollapsed", "1");
    let reveal: ((p: string) => void) | null = null;
    render(
      <ReviewSidebar
        changedCount={0}
        {...baseProps}
        fileTree={{ ...baseProps.fileTree, registerLocate: (fn) => { reveal = fn; } }}
      />,
    );
    expect(screen.queryByTestId("files-tree")).not.toBeInTheDocument();

    await act(async () => reveal!("/repo/src/lib/modeMeta.ts"));

    await screen.findByTestId("files-tree");
    await waitFor(() => expect(treeLocateSpy).toHaveBeenCalledWith("/repo/src/lib/modeMeta.ts"));
  });

  // Visual audit #358: at 1280×800 the Review area is ~720px, and a 280px tree
  // beside the diff left neither toolbar room for its controls.
  describe("narrow Review area", () => {
    let areaWidth = 0;
    let observers: Array<() => void> = [];
    const OriginalRO = globalThis.ResizeObserver;

    beforeEach(() => {
      observers = [];
      globalThis.ResizeObserver = class {
        cb: () => void;
        constructor(cb: () => void) { this.cb = cb; }
        observe() { observers.push(this.cb); }
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;
    });
    afterEach(() => {
      globalThis.ResizeObserver = OriginalRO;
    });

    function renderInArea(width: number, props: Partial<React.ComponentProps<typeof ReviewSidebar>> = {}) {
      areaWidth = width;
      const area = document.createElement("div");
      Object.defineProperty(area, "clientWidth", { get: () => areaWidth });
      document.body.appendChild(area);
      return render(<ReviewSidebar changedCount={2} {...baseProps} {...props} />, { container: area });
    }
    const resizeArea = (width: number) =>
      act(() => {
        areaWidth = width;
        observers.forEach((cb) => cb());
      });

    it("starts collapsed below 760px even when the stored preference is expanded", () => {
      localStorage.setItem("reviewSidebarCollapsed", "0");
      renderInArea(720);
      expect(screen.getByTestId("review-sidebar-strip")).toBeInTheDocument();
      expect(screen.queryByTestId("changes-panel")).not.toBeInTheDocument();
    });

    it("stays expanded at 760px and wider", () => {
      renderInArea(760);
      expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
    });

    it("an unmeasured (hidden) area keeps the stored preference", () => {
      renderInArea(0);
      expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
    });

    it("collapses when the area narrows and restores the preference when it widens", () => {
      renderInArea(1000);
      expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
      resizeArea(700);
      expect(screen.getByTestId("review-sidebar-strip")).toBeInTheDocument();
      resizeArea(1000);
      expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
    });

    it("expanding while narrow is transient: it never overwrites the stored preference", async () => {
      localStorage.setItem("reviewSidebarCollapsed", "1");
      renderInArea(700);
      await userEvent.click(screen.getByRole("button", { name: /expand changes & files/i }));
      expect(screen.getByTestId("changes-panel")).toBeInTheDocument();
      expect(localStorage.getItem("reviewSidebarCollapsed")).toBe("1");

      await userEvent.click(screen.getByRole("button", { name: /collapse changes & files/i }));
      expect(screen.getByTestId("review-sidebar-strip")).toBeInTheDocument();
      expect(localStorage.getItem("reviewSidebarCollapsed")).toBe("1");
    });

    it("the focus-commit shortcut still reveals Changes on a narrow area", async () => {
      let focusCommit: (() => void) | undefined;
      renderInArea(700, { registerFocusCommit: (fn) => { focusCommit = fn; } });
      expect(screen.getByTestId("review-sidebar-strip")).toBeInTheDocument();
      act(() => focusCommit?.());
      expect(await screen.findByTestId("changes-panel")).toBeInTheDocument();
      expect(changesFocusSpy).toHaveBeenCalled();
    });
  });

  describe("resize", () => {
    it("drags the right edge to widen, clamps, and persists on release", () => {
      render(<ReviewSidebar changedCount={0} {...baseProps} />);
      const sidebar = screen.getByTestId("review-sidebar");
      const handle = screen.getByRole("separator", { name: /resize changes & files/i });
      expect(sidebar.style.width).toBe("280px");

      act(() => {
        handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 280 }));
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
      });
      expect(sidebar.style.width).toBe("400px");

      act(() => {
        window.dispatchEvent(new MouseEvent("mousemove", { clientX: 5000 }));
        window.dispatchEvent(new MouseEvent("mouseup"));
      });
      expect(sidebar.style.width).toBe("640px");
      expect(localStorage.getItem("reviewSidebarWidth")).toBe("640");
    });

    it("an unmount mid-drag releases the body and the window listeners", () => {
      const { unmount } = render(<ReviewSidebar changedCount={0} {...baseProps} />);
      const handle = screen.getByRole("separator", { name: /resize changes & files/i });
      act(() => {
        handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 280 }));
      });
      expect(document.body.style.cursor).toBe("col-resize");
      const removeSpy = vi.spyOn(window, "removeEventListener");
      unmount();
      expect(document.body.style.cursor).toBe("");
      expect(document.body.style.userSelect).toBe("");
      expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith("mouseup", expect.any(Function));
      removeSpy.mockRestore();
    });

    it("restores the stored width and double-click resets it", async () => {
      localStorage.setItem("reviewSidebarWidth", "420");
      render(<ReviewSidebar changedCount={0} {...baseProps} />);
      const sidebar = screen.getByTestId("review-sidebar");
      expect(sidebar.style.width).toBe("420px");
      await userEvent.dblClick(screen.getByRole("separator", { name: /resize changes & files/i }));
      expect(sidebar.style.width).toBe("280px");
      expect(localStorage.getItem("reviewSidebarWidth")).toBe("280");
    });

    it("resizes from the keyboard with the arrow keys", async () => {
      render(<ReviewSidebar changedCount={0} {...baseProps} />);
      const handle = screen.getByRole("separator", { name: /resize changes & files/i });
      handle.focus();
      await userEvent.keyboard("{ArrowRight}{ArrowRight}");
      expect(screen.getByTestId("review-sidebar").style.width).toBe("312px");
      await userEvent.keyboard("{Home}");
      expect(screen.getByTestId("review-sidebar").style.width).toBe("200px");
    });
  });
});
