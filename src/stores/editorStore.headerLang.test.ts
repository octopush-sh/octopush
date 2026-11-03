import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileChecked = vi.fn();
const listWorkspaceFiles = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    readFileChecked: (...a: unknown[]) => readFileChecked(...a),
    listWorkspaceFiles: (...a: unknown[]) => listWorkspaceFiles(...a),
  },
}));
vi.mock("../components/Toasts", () => ({ pushToast: vi.fn() }));

import { resetHeaderLangCache, useEditorStore } from "./editorStore";

const langOf = (path: string) =>
  useEditorStore.getState().getFiles("ws").find((f) => f.path === path)?.lang;

describe("editorStore: .h files", () => {
  beforeEach(() => {
    useEditorStore.setState({
      filesByWs: {}, activeByWs: {}, saveConflict: null, pendingRevealByWs: {}, navByWs: {},
    });
    resetHeaderLangCache();
    vi.clearAllMocks();
    readFileChecked.mockResolvedValue({ kind: "text", content: "int x;", size: 6, mtime: 1 });
  });

  it.each([".cpp", ".cc", ".cxx", ".hpp", ".hh"])("open as C++ when the workspace has %s files", async (ext) => {
    listWorkspaceFiles.mockResolvedValue(["include/a.h", `src/main${ext}`]);
    await useEditorStore.getState().openAsJump("ws", "/repo/include/a.h", { root: "/repo" });
    expect(listWorkspaceFiles).toHaveBeenCalledWith("/repo");
    expect(langOf("/repo/include/a.h")).toBe("cpp");
  });

  it("stay C in a C-only workspace", async () => {
    listWorkspaceFiles.mockResolvedValue(["include/a.h", "src/main.c"]);
    await useEditorStore.getState().openAsJump("ws", "/repo/include/a.h", { root: "/repo" });
    expect(langOf("/repo/include/a.h")).toBe("c");
  });

  it("stay C when the listing fails or the root is unknown", async () => {
    listWorkspaceFiles.mockRejectedValue("denied");
    await useEditorStore.getState().openAsJump("ws", "/repo/a.h", { root: "/repo" });
    expect(langOf("/repo/a.h")).toBe("c");
    await useEditorStore.getState().openFile("other", "/x/b.h");
    expect(useEditorStore.getState().getFiles("other")[0].lang).toBe("c");
  });

  it("list the workspace once, and never for other files", async () => {
    listWorkspaceFiles.mockResolvedValue(["src/main.cpp"]);
    await useEditorStore.getState().openAsJump("ws", "/repo/main.go", { root: "/repo" });
    expect(listWorkspaceFiles).not.toHaveBeenCalled();
    expect(langOf("/repo/main.go")).toBe("go");
    await useEditorStore.getState().openAsJump("ws", "/repo/a.h", { root: "/repo" });
    await useEditorStore.getState().openFile("ws", "/repo/b.h");
    expect(listWorkspaceFiles).toHaveBeenCalledTimes(1);
    expect(langOf("/repo/b.h")).toBe("cpp");
  });
});
