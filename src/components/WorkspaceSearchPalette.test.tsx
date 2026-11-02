import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchHit } from "../lib/types";
import { useEditorStore, type OpenFile } from "../stores/editorStore";

const { listWorkspaceFiles, searchWorkspaceText } = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  searchWorkspaceText: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { listWorkspaceFiles, searchWorkspaceText },
}));

import { WorkspaceSearchPalette } from "./WorkspaceSearchPalette";

const HITS: SearchHit[] = [
  { file: "src/lib/ipc.ts", line: 412, col: 3, preview: "  const total = 1;" },
  { file: "src/App.tsx", line: 7, col: 1, preview: "total()" },
];

beforeEach(() => {
  vi.clearAllMocks();
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
  function renderFiles(paths: string[], onOpenFile = vi.fn()) {
    listWorkspaceFiles.mockResolvedValue(paths);
    render(
      <WorkspaceSearchPalette
        workspacePath="/w"
        initialMode="files"
        open
        onClose={vi.fn()}
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

  it("arrow keys move the selection; Enter opens it", async () => {
    const user = userEvent.setup();
    const onOpenFile = renderFiles(["a.ts", "b.ts", "c.ts"]);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    await user.type(input(), "{ArrowDown}{ArrowDown}{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("c.ts");
  });

  it("renders only a window of rows for a big workspace, and says when the list was capped", async () => {
    renderFiles(Array.from({ length: 20_000 }, (_, i) => `src/f${i}.ts`));
    await waitFor(() => expect(screen.getByText("Showing the first 20,000 files")).toBeTruthy());
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
