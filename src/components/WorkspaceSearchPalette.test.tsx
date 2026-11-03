import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchHit } from "../lib/types";
import { useEditorStore, type OpenFile } from "../stores/editorStore";
import { useRecentFilesStore } from "../stores/recentFilesStore";

const { listWorkspaceFiles, searchWorkspaceText } = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  searchWorkspaceText: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { listWorkspaceFiles, searchWorkspaceText },
}));

// `stall` keeps every ranking job unfinished, as when typing outpaces the
// sliced ranking of a big workspace. `matchFiles` keeps the real job.
const ranking = vi.hoisted(() => ({ stall: false }));
vi.mock("../lib/fileMatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/fileMatch")>();
  return {
    ...actual,
    createMatchJob: (...args: Parameters<typeof actual.createMatchJob>) =>
      ranking.stall ? { step: () => false, result: () => [] } : actual.createMatchJob(...args),
  };
});

import { WorkspaceSearchPalette } from "./WorkspaceSearchPalette";

const HITS: SearchHit[] = [
  { file: "src/lib/ipc.ts", line: 412, col: 3, preview: "  const total = 1;" },
  { file: "src/App.tsx", line: 7, col: 1, preview: "total()" },
];

beforeEach(() => {
  vi.clearAllMocks();
  ranking.stall = false;
  // Files opened by earlier tests would otherwise win ties here.
  useRecentFilesStore.setState({ byWs: {} });
  listWorkspaceFiles.mockResolvedValue(["src/lib/ipc.ts", "src/App.tsx"]);
  searchWorkspaceText.mockResolvedValue(HITS);
});

function setup(onOpenFile = vi.fn()) {
  render(
    <WorkspaceSearchPalette
      workspacePath="/w"
      initialMode="text"
      open
      onClose={vi.fn()}
      onOpenFile={onOpenFile}
    />,
  );
  return onOpenFile;
}

describe("WorkspaceSearchPalette — text mode", () => {
  it("opens the picked hit AT its line, not at the top of the file", async () => {
    // The regression this guards: the palette used to hand the parent only the
    // path, so clicking a match opened the file and left the reader on line 1
    // to find it again by hand.
    const user = userEvent.setup();
    const onOpenFile = setup();

    await user.type(screen.getByPlaceholderText("Search text in every file…"), "total");
    await waitFor(() => expect(screen.getByText("src/lib/ipc.ts")).toBeTruthy());

    await user.click(screen.getByText("src/lib/ipc.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/lib/ipc.ts", 412);
  });

  it("shows each hit's line number", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByPlaceholderText("Search text in every file…"), "total");
    await waitFor(() => expect(screen.getByText(":412")).toBeTruthy());
    expect(screen.getByText(":7")).toBeTruthy();
  });
});

describe("WorkspaceSearchPalette — file mode", () => {
  it("opens a picked file with no line, leaving the cursor where it was", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(
      <WorkspaceSearchPalette
        workspacePath="/w"
        initialMode="files"
        open
        onClose={vi.fn()}
        onOpenFile={onOpenFile}
      />,
    );
    await waitFor(() => expect(screen.getByText("ipc.ts")).toBeTruthy());
    await user.click(screen.getByText("ipc.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/lib/ipc.ts");
  });
});

describe("WorkspaceSearchPalette — file finder matching", () => {
  function renderFiles(paths: string[], onOpenFile = vi.fn(), onClose = vi.fn()) {
    listWorkspaceFiles.mockResolvedValue(paths);
    render(
      <WorkspaceSearchPalette
        workspacePath="/w"
        initialMode="files"
        open
        onClose={onClose}
        onOpenFile={onOpenFile}
      />,
    );
    return onOpenFile;
  }
  const input = () => screen.getByRole("combobox");
  const optionNames = () =>
    screen.getAllByRole("option").map((o) => o.querySelector("span")?.textContent);

  it("a *.java glob finds Java files (cmdk's scorer found none)", async () => {
    const user = userEvent.setup();
    renderFiles(["pom.xml", "src/main/java/com/acme/service/UserService.java", "README.md"]);
    await waitFor(() => expect(screen.getByText("pom.xml")).toBeTruthy());
    await user.type(input(), "*.java");
    await waitFor(() => expect(optionNames()).toEqual(["UserService.java"]));
  });

  it("Foo.java:42 + Enter opens Foo.java at line 42; :line:col passes the column", async () => {
    const user = userEvent.setup();
    const onOpenFile = renderFiles(["src/Bar.java", "src/Foo.java"]);
    await waitFor(() => expect(screen.getByText("Foo.java")).toBeTruthy());
    await user.type(input(), "Foo.java:42{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("src/Foo.java", 42);

    cleanup();
    const onOpen2 = renderFiles(["src/Foo.java"]);
    await waitFor(() => expect(screen.getByText("Foo.java")).toBeTruthy());
    await user.type(input(), "Foo.java:42:7{Enter}");
    expect(onOpen2).toHaveBeenCalledWith("src/Foo.java", 42, 7);
  });

  it("a bare :42 is no query: every file listed, no :line, Enter passes no line", async () => {
    const user = userEvent.setup();
    const onOpenFile = renderFiles(["src/Bar.java", "src/Foo.java"]);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await user.type(input(), ":42");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.queryByText(":42")).toBeNull();
    await user.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("src/Bar.java");
  });

  it("a trailing colon typed on the way to :line keeps the matches", async () => {
    const user = userEvent.setup();
    renderFiles(["src/Bar.java", "src/Foo.java"]);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await user.type(input(), "Foo.java:");
    await waitFor(() => expect(optionNames()).toEqual(["Foo.java"]));
  });

  it("arrow keys move the selection; Enter opens it", async () => {
    const user = userEvent.setup();
    const onOpenFile = renderFiles(["a.ts", "b.ts", "c.ts"]);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    await user.type(input(), "{ArrowDown}{ArrowDown}{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("c.ts");
  });

  it("the selected row is highlighted and named on the focused input", async () => {
    const user = userEvent.setup();
    renderFiles(["a.ts", "b.ts", "c.ts"]);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    await user.type(input(), "{ArrowDown}");

    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    // The highlight is a background on the row itself; the cmdk rule in
    // CommandPalette doesn't reach these rows.
    expect(rows[1].className).toContain("aria-selected:bg-[var(--brass-ghost)]");
    // Focus stays in the input, so it carries the active option.
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-activedescendant")).toBe(rows[1].id);
    expect(input().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("ArrowUp from the first row wraps to the last", async () => {
    const user = userEvent.setup();
    const onOpenFile = renderFiles(["a.ts", "b.ts", "c.ts"]);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    await user.type(input(), "{ArrowUp}");
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("c.ts");
  });

  it("Enter before the ranking catches up opens the match for what was typed", async () => {
    const user = userEvent.setup();
    const onOpenFile = renderFiles(["src/Bar.java", "src/Foo.java"]);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    // On screen: the ranking for the empty query, Bar.java first.
    expect(screen.getAllByRole("option")[0].textContent).toContain("Bar.java");
    ranking.stall = true;
    await user.type(input(), "foo{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("src/Foo.java");
  });

  it("ranks a 20,000-file workspace across slices and shows the match", async () => {
    const user = userEvent.setup();
    renderFiles(Array.from({ length: 20_000 }, (_, i) => `src/f${i}.ts`));
    await waitFor(() => expect(screen.getByText("f0.ts")).toBeTruthy());
    await user.type(input(), "f19999");
    await waitFor(() => expect(screen.getAllByRole("option")[0].textContent).toContain("f19999.ts"));
  });

  it("says when nothing matches", async () => {
    const user = userEvent.setup();
    renderFiles(["a.ts"]);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    await user.type(input(), "zzz");
    await waitFor(() => expect(screen.getByText("No matching files.")).toBeTruthy());
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("says it is scanning while the listing is pending", async () => {
    listWorkspaceFiles.mockReturnValue(new Promise(() => {}));
    render(
      <WorkspaceSearchPalette
        workspacePath="/w"
        initialMode="files"
        open
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(await screen.findByText("Scanning workspace…")).toBeTruthy();
  });

  it("shows the error when the listing fails, not an empty workspace", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => quiet.mockRestore());
    listWorkspaceFiles.mockRejectedValue("permission denied");
    render(
      <WorkspaceSearchPalette
        workspacePath="/w"
        initialMode="files"
        open
        onClose={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    const line = await screen.findByText(
      "Couldn't list the files in this workspace: permission denied",
    );
    expect(line.className).toContain("text-octo-rouge");
    expect(screen.queryByText("No files in this workspace.")).toBeNull();
  });

  it("Escape closes the palette from the file list", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderFiles(["a.ts"], vi.fn(), onClose);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    await user.type(input(), "{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("renders only a window of rows for a big workspace, and says when the list was capped", async () => {
    renderFiles(Array.from({ length: 20_000 }, (_, i) => `src/f${i}.ts`));
    await waitFor(() => expect(screen.getByText("Showing the first 20,000 files")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("option").length).toBeLessThan(60);
  });

  it("no cap notice below the cap", async () => {
    renderFiles(["a.ts"]);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it("open tabs win ties", async () => {
    useEditorStore.setState({
      filesByWs: { ws: [{ path: "/w/b/Foo.java" } as OpenFile] },
    });
    try {
      renderFiles(["a/Foo.java", "b/Foo.java"]);
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
      expect(screen.getAllByRole("option")[0].textContent).toContain("b");
    } finally {
      act(() => useEditorStore.setState({ filesByWs: {} }));
    }
  });
});
