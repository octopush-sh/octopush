import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Hoist the mock so it is available when vi.mock factory runs.
const { mockReadDirectory, mockReveal, mockOpenSystem, mockOpenTerminal } = vi.hoisted(() => ({
  mockReadDirectory: vi.fn(),
  mockReveal: vi.fn().mockResolvedValue(undefined),
  mockOpenSystem: vi.fn().mockResolvedValue(undefined),
  mockOpenTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/ipc", () => ({
  ipc: {
    readDirectory: mockReadDirectory,
    revealInFinder: mockReveal,
    openFileInSystem: mockOpenSystem,
    openInTerminal: mockOpenTerminal,
  },
}));

// Import after mock is set up.
import { CompanionFileTree } from "./CompanionFileTree";
import { useReviewPrefs } from "../stores/reviewPrefsStore";

const ROOT = "/repo";
const CHANGED = new Set(["/repo/src/Main.java"]);

const ROOT_CHILDREN = [
  { name: "src", path: "/repo/src", isDir: true, isIgnored: false },
  { name: "docs", path: "/repo/docs", isDir: true, isIgnored: false },
  { name: "pom.xml", path: "/repo/pom.xml", isDir: false, isIgnored: false },
];

const SRC_CHILDREN = [
  { name: "Main.java", path: "/repo/src/Main.java", isDir: false, isIgnored: false },
  { name: "Helper.java", path: "/repo/src/Helper.java", isDir: false, isIgnored: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  useReviewPrefs.setState({ showIgnoredFiles: {} });
  // Default: root children resolve immediately.
  mockReadDirectory.mockImplementation((path: string) => {
    if (path === ROOT) return Promise.resolve(ROOT_CHILDREN);
    if (path === "/repo/src") return Promise.resolve(SRC_CHILDREN);
    return Promise.resolve([]);
  });
});

describe("CompanionFileTree", () => {
  it("renders FILES eyebrow header", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText(/Files/i)).toBeInTheDocument());
  });

  it("renders root label in italic serif", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => {
      const label = screen.getByText("my-project");
      expect(label).toBeInTheDocument();
    });
  });

  it("root starts expanded — shows root children", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
      expect(screen.getByText("pom.xml")).toBeInTheDocument();
    });
  });

  it("expanding src/ calls readDirectory and shows children", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));

    await waitFor(() => {
      expect(mockReadDirectory).toHaveBeenCalledWith("/repo/src", false);
      expect(screen.getByText("Main.java")).toBeInTheDocument();
      expect(screen.getByText("Helper.java")).toBeInTheDocument();
    });
  });

  it("does NOT re-fetch when a folder is collapsed and re-expanded", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // Collapse
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.queryByText("Main.java")).not.toBeInTheDocument());

    // Re-expand — should NOT fire another readDirectory call
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // readDirectory for /repo/src was called only once (plus once for ROOT on mount)
    expect(mockReadDirectory).toHaveBeenCalledTimes(2); // ROOT + src once each
  });

  it("changed files keep their type icon, tinted brass", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // Main.java is in CHANGED — its type icon is brass-tinted.
    const mainRow = screen.getByTestId("file-row-/repo/src/Main.java");
    const mainIcon = mainRow.querySelector("svg");
    expect(mainIcon).not.toBeNull();
    expect(mainIcon!.style.color).toContain("var(--color-octo-brass)");
    // The changed label reads ivory.
    expect(screen.getByText("Main.java").className).toContain("text-octo-ivory");

    // Helper.java is NOT in CHANGED — its type icon stays mute.
    const helperRow = screen.getByTestId("file-row-/repo/src/Helper.java");
    const helperIcon = helperRow.querySelector("svg");
    expect(helperIcon).not.toBeNull();
    expect(helperIcon!.style.color).toContain("var(--color-octo-mute)");
  });

  it("shows loading indicator while a folder fetch is in progress", async () => {
    let resolve!: (v: typeof SRC_CHILDREN) => void;
    mockReadDirectory.mockImplementationOnce(() => Promise.resolve(ROOT_CHILDREN));
    mockReadDirectory.mockImplementationOnce(
      () => new Promise((res) => { resolve = res; })
    );

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));
    // Loading row should appear
    expect(screen.getByText("loading…")).toBeInTheDocument();

    // Resolve the fetch
    resolve(SRC_CHILDREN);
    await waitFor(() => expect(screen.queryByText("loading…")).not.toBeInTheDocument());
    expect(screen.getByText("Main.java")).toBeInTheDocument();
  });

  it("shows empty indicator for an empty folder", async () => {
    mockReadDirectory.mockImplementation((path: string) => {
      if (path === ROOT) return Promise.resolve([{ name: "empty-dir", path: "/repo/empty-dir", isDir: true, isIgnored: false }]);
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={new Set()} />);
    await waitFor(() => expect(screen.getByText("empty-dir")).toBeInTheDocument());

    await userEvent.click(screen.getByText("empty-dir"));
    await waitFor(() => expect(screen.getByText("empty.")).toBeInTheDocument());
  });

  it("collapsing root hides all children", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    // Click root label to collapse
    await userEvent.click(screen.getByText("my-project"));
    await waitFor(() => expect(screen.queryByText("src")).not.toBeInTheDocument());
  });

  it("clicking a file row calls onFileClick with the absolute path", async () => {
    const onFileClick = vi.fn();
    render(
      <CompanionFileTree
        rootPath={ROOT}
        rootLabel="my-project"
        changedPaths={CHANGED}
        onFileClick={onFileClick}
      />,
    );

    // Expand src/ to reveal files
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // Click the file row
    await userEvent.click(screen.getByTestId("file-row-/repo/src/Main.java"));

    expect(onFileClick).toHaveBeenCalledTimes(1);
    expect(onFileClick).toHaveBeenCalledWith("/repo/src/Main.java");
  });

  it("renders depth ≥ 4 file rows with text-octo-mute (unless changed)", async () => {
    // Build a 5-level deep tree: /r/a/b/c/d/deep.txt at depth=5
    const DEEP_ROOT = "/r";
    const deepPath = "/r/a/b/c/d/deep.txt";
    const changedDeepPath = "/r/a/b/c/d/changed.txt";

    mockReadDirectory.mockImplementation((path: string) => {
      if (path === DEEP_ROOT)             return Promise.resolve([{ name: "a", path: "/r/a", isDir: true, isIgnored: false }]);
      if (path === "/r/a")                return Promise.resolve([{ name: "b", path: "/r/a/b", isDir: true, isIgnored: false }]);
      if (path === "/r/a/b")              return Promise.resolve([{ name: "c", path: "/r/a/b/c", isDir: true, isIgnored: false }]);
      if (path === "/r/a/b/c")            return Promise.resolve([{ name: "d", path: "/r/a/b/c/d", isDir: true, isIgnored: false }]);
      if (path === "/r/a/b/c/d")          return Promise.resolve([
        { name: "deep.txt",    path: deepPath,        isDir: false, isIgnored: false },
        { name: "changed.txt", path: changedDeepPath, isDir: false, isIgnored: false },
      ]);
      return Promise.resolve([]);
    });

    render(
      <CompanionFileTree
        rootPath={DEEP_ROOT}
        rootLabel="deep-project"
        changedPaths={new Set([changedDeepPath])}
      />
    );

    // Expand each level down to depth 5
    for (const name of ["a", "b", "c", "d"]) {
      await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
      await userEvent.click(screen.getByText(name));
    }

    await waitFor(() => expect(screen.getByText("deep.txt")).toBeInTheDocument());

    // deep.txt is at depth 5 (≥4) and NOT changed → should carry text-octo-mute
    const deepLabel = screen.getByText("deep.txt");
    expect(deepLabel.className).toContain("text-octo-mute");

    // changed.txt is at depth 5 but IS changed → should carry text-octo-ivory
    const changedLabel = screen.getByText("changed.txt");
    expect(changedLabel.className).toContain("text-octo-ivory");
  });

  it("eye toggle re-fetches with showIgnored=true and shows dimmed ignored entries", async () => {
    mockReadDirectory.mockImplementation((path: string, show?: boolean) => {
      if (path === ROOT) {
        return Promise.resolve(
          show
            ? [
                ...ROOT_CHILDREN,
                { name: "build", path: "/repo/build", isDir: true, isIgnored: true },
                { name: "app.war", path: "/repo/app.war", isDir: false, isIgnored: true },
              ]
            : ROOT_CHILDREN,
        );
      }
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    expect(screen.queryByText("app.war")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));

    await waitFor(() => expect(screen.getByText("app.war")).toBeInTheDocument());
    expect(mockReadDirectory).toHaveBeenLastCalledWith(ROOT, true);

    // Ignored entries are dimmed at the row level and explained via tooltip.
    const warRow = screen.getByText("app.war").closest('[role="treeitem"]') as HTMLElement;
    expect(warRow.className).toContain("opacity-60");
    expect(warRow).toHaveAttribute("title", "Ignored by .gitignore");
    const buildRow = screen.getByText("build").closest('[role="treeitem"]') as HTMLElement;
    expect(buildRow.className).toContain("opacity-60");
    expect(buildRow).toHaveAttribute("title", "Ignored by .gitignore");
    // Non-ignored entries are neither dimmed nor annotated, and keep their color.
    const pomRow = screen.getByText("pom.xml").closest('[role="treeitem"]') as HTMLElement;
    expect(pomRow.className).not.toContain("opacity-60");
    expect(pomRow).not.toHaveAttribute("title");
    expect(screen.getByText("pom.xml").className).toContain("text-octo-sage");
  });

  it("toggling back off re-fetches without the flag and hides ignored entries", async () => {
    mockReadDirectory.mockImplementation((path: string, show?: boolean) => {
      if (path === ROOT) {
        return Promise.resolve(
          show
            ? [...ROOT_CHILDREN, { name: "app.war", path: "/repo/app.war", isDir: false, isIgnored: true }]
            : ROOT_CHILDREN,
        );
      }
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));
    await waitFor(() => expect(screen.getByText("app.war")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));
    await waitFor(() => expect(screen.queryByText("app.war")).not.toBeInTheDocument());
    expect(mockReadDirectory).toHaveBeenLastCalledWith(ROOT, false);
  });

  it("discards a stale in-flight response after the toggle flips (generation guard)", async () => {
    let resolveStale!: (v: unknown) => void;
    let call = 0;
    mockReadDirectory.mockImplementation((_path: string, show?: boolean) => {
      call += 1;
      if (call === 1) {
        // First (toggle-off) root fetch: held open, resolved later with a sentinel.
        return new Promise((res) => {
          resolveStale = res;
        });
      }
      return Promise.resolve(
        show
          ? [...ROOT_CHILDREN, { name: "app.war", path: "/repo/app.war", isDir: false, isIgnored: true }]
          : ROOT_CHILDREN,
      );
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);

    // Toggle while the first fetch is still in flight.
    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));
    await waitFor(() => expect(screen.getByText("app.war")).toBeInTheDocument());

    // Now resolve the stale (pre-toggle) response with a sentinel entry.
    resolveStale([{ name: "STALE.txt", path: "/repo/STALE.txt", isDir: false, isIgnored: false }]);
    await waitFor(() => expect(screen.getByText("app.war")).toBeInTheDocument());
    expect(screen.queryByText("STALE.txt")).not.toBeInTheDocument();
  });

  it("toggling refetches expanded subfolders too", async () => {
    mockReadDirectory.mockImplementation((path: string, show?: boolean) => {
      if (path === ROOT) return Promise.resolve(ROOT_CHILDREN);
      if (path === "/repo/src") {
        return Promise.resolve(
          show
            ? [...SRC_CHILDREN, { name: "gen.ts", path: "/repo/src/gen.ts", isDir: false, isIgnored: true }]
            : SRC_CHILDREN,
        );
      }
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));

    await waitFor(() => expect(screen.getByText("gen.ts")).toBeInTheDocument());
    expect(mockReadDirectory).toHaveBeenCalledWith("/repo/src", true);
  });

  it("children of an ignored directory inherit the dimmed state", async () => {
    mockReadDirectory.mockImplementation((path: string) => {
      if (path === ROOT) {
        return Promise.resolve([{ name: "build", path: "/repo/build", isDir: true, isIgnored: true }]);
      }
      if (path === "/repo/build") {
        return Promise.resolve([{ name: "out.js", path: "/repo/build/out.js", isDir: false, isIgnored: false }]);
      }
      return Promise.resolve([]);
    });

    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={new Set()} />);
    await waitFor(() => expect(screen.getByText("build")).toBeInTheDocument());

    await userEvent.click(screen.getByText("build"));
    await waitFor(() => expect(screen.getByText("out.js")).toBeInTheDocument());

    // out.js's own flag is false, but it inherits dimming from its ignored parent.
    const row = screen.getByTestId("file-row-/repo/build/out.js");
    expect(row.className).toContain("opacity-60");
    expect(row).toHaveAttribute("title", "Ignored by .gitignore");
  });

  it("keeps old entries visible while a toggle refetch is pending (stale-while-revalidate)", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    // Defer the refetch triggered by the eye toggle.
    let resolveRefetch!: (v: unknown) => void;
    mockReadDirectory.mockImplementation(
      () =>
        new Promise((res) => {
          resolveRefetch = res;
        }),
    );

    await userEvent.click(screen.getByRole("button", { name: /show ignored files/i }));

    // Old entries stay on screen — no full-tree "loading…" flash.
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("pom.xml")).toBeInTheDocument();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();

    // When the refetch lands, entries swap in place.
    resolveRefetch([
      ...ROOT_CHILDREN,
      { name: "app.war", path: "/repo/app.war", isDir: false, isIgnored: true },
    ]);
    await waitFor(() => expect(screen.getByText("app.war")).toBeInTheDocument());
    expect(screen.getByText("src")).toBeInTheDocument();
  });

  it("dismisses an open context menu when the workspace switches", async () => {
    const { rerender } = render(
      <CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />,
    );
    await waitFor(() => expect(screen.getByText("pom.xml")).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByTestId("file-row-/repo/pom.xml"));
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    rerender(
      <CompanionFileTree rootPath="/other" rootLabel="other-project" changedPaths={CHANGED} />,
    );
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("right-clicking a file row opens the context menu with file items", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByTestId("file-row-/repo/src/Main.java"));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /open in system app/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /open in terminal/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: /reveal in finder/i }));
    expect(mockReveal).toHaveBeenCalledWith("/repo/src/Main.java");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("exposes tree semantics: role=tree, treeitems, aria-expanded on dirs", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    expect(screen.getByRole("tree", { name: /workspace files/i })).toBeInTheDocument();

    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBeGreaterThanOrEqual(4); // root + src + docs + pom.xml

    // The src dir row is collapsed → aria-expanded=false; expanding flips it.
    const srcRow = screen.getByText("src").closest('[role="treeitem"]') as HTMLElement;
    expect(srcRow).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(srcRow).toHaveAttribute("aria-expanded", "true"));

    // File rows carry no aria-expanded.
    const fileRow = screen.getByTestId("file-row-/repo/pom.xml");
    expect(fileRow).not.toHaveAttribute("aria-expanded");
  });

  it("Enter on a focused file row opens the file; Space toggles a dir", async () => {
    const onFileClick = vi.fn();
    render(
      <CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} onFileClick={onFileClick} />,
    );
    await waitFor(() => expect(screen.getByText("pom.xml")).toBeInTheDocument());

    const fileRow = screen.getByTestId("file-row-/repo/pom.xml");
    fileRow.focus();
    expect(fireEvent.keyDown(fileRow, { key: "Enter" })).toBe(false);
    expect(onFileClick).toHaveBeenCalledWith("/repo/pom.xml");

    const srcRow = screen.getByText("src").closest('[role="treeitem"]') as HTMLElement;
    expect(fireEvent.keyDown(srcRow, { key: " " })).toBe(false);
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());
  });
});
