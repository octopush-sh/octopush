import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SearchHit } from "../lib/types";

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
