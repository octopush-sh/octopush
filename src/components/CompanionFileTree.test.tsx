import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Hoist the mock so it is available when vi.mock factory runs.
const { mockReadDirectory } = vi.hoisted(() => ({
  mockReadDirectory: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { readDirectory: mockReadDirectory },
}));

// Import after mock is set up.
import { CompanionFileTree } from "./CompanionFileTree";

const ROOT = "/repo";
const CHANGED = new Set(["/repo/src/Main.java"]);

const ROOT_CHILDREN = [
  { name: "src", path: "/repo/src", isDir: true },
  { name: "docs", path: "/repo/docs", isDir: true },
  { name: "pom.xml", path: "/repo/pom.xml", isDir: false },
];

const SRC_CHILDREN = [
  { name: "Main.java", path: "/repo/src/Main.java", isDir: false },
  { name: "Helper.java", path: "/repo/src/Helper.java", isDir: false },
];

beforeEach(() => {
  vi.clearAllMocks();
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
    await waitFor(() => expect(screen.getByText("FILES")).toBeInTheDocument());
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
      expect(mockReadDirectory).toHaveBeenCalledWith("/repo/src");
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

  it("shows brass dot for changed files", async () => {
    render(<CompanionFileTree rootPath={ROOT} rootLabel="my-project" changedPaths={CHANGED} />);
    await waitFor(() => expect(screen.getByText("src")).toBeInTheDocument());

    await userEvent.click(screen.getByText("src"));
    await waitFor(() => expect(screen.getByText("Main.java")).toBeInTheDocument());

    // Main.java is in CHANGED — its row should contain ●
    const mainRow = screen.getByTestId("file-row-/repo/src/Main.java");
    expect(mainRow.textContent).toContain("●");

    // Helper.java is NOT in CHANGED — its row should contain ◦ (or no ●)
    const helperRow = screen.getByTestId("file-row-/repo/src/Helper.java");
    expect(helperRow.textContent).not.toContain("●");
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
      if (path === ROOT) return Promise.resolve([{ name: "empty-dir", path: "/repo/empty-dir", isDir: true }]);
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
      if (path === DEEP_ROOT)             return Promise.resolve([{ name: "a", path: "/r/a", isDir: true }]);
      if (path === "/r/a")                return Promise.resolve([{ name: "b", path: "/r/a/b", isDir: true }]);
      if (path === "/r/a/b")              return Promise.resolve([{ name: "c", path: "/r/a/b/c", isDir: true }]);
      if (path === "/r/a/b/c")            return Promise.resolve([{ name: "d", path: "/r/a/b/c/d", isDir: true }]);
      if (path === "/r/a/b/c/d")          return Promise.resolve([
        { name: "deep.txt",    path: deepPath,        isDir: false },
        { name: "changed.txt", path: changedDeepPath, isDir: false },
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
});
