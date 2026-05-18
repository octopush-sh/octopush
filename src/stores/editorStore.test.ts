import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock IPC ─────────────────────────────────────────────────────
const mockIpc = {
  readFile: vi.fn<(path: string) => Promise<string>>(),
  writeFile: vi.fn<(path: string, content: string) => Promise<void>>(),
};

vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useEditorStore } = await import("./editorStore");

// ─── Helpers ──────────────────────────────────────────────────────

function reset() {
  useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
  vi.clearAllMocks();
}

// ─── Tests ────────────────────────────────────────────────────────

describe("editorStore — openFile", () => {
  beforeEach(reset);

  it("reads from IPC and stores file on first open", async () => {
    mockIpc.readFile.mockResolvedValueOnce("hello");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    const files = useEditorStore.getState().getFiles("ws-1");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/repo/foo.ts");
    expect(files[0].content).toBe("hello");
    expect(files[0].savedContent).toBe("hello");
    expect(useEditorStore.getState().getActivePath("ws-1")).toBe("/repo/foo.ts");
  });

  it("does NOT re-read if file is already open — just activates", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    // Manually dirty the buffer
    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "edited");

    // Open again
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    // readFile was only called once; content is still the edited version
    expect(mockIpc.readFile).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().getFiles("ws-1")[0].content).toBe("edited");
  });

  it("opens multiple files in the same workspace", async () => {
    mockIpc.readFile
      .mockResolvedValueOnce("a content")
      .mockResolvedValueOnce("b content");

    await useEditorStore.getState().openFile("ws-1", "/repo/a.ts");
    await useEditorStore.getState().openFile("ws-1", "/repo/b.ts");

    const files = useEditorStore.getState().getFiles("ws-1");
    expect(files).toHaveLength(2);
    expect(useEditorStore.getState().getActivePath("ws-1")).toBe("/repo/b.ts");
  });
});

describe("editorStore — closeFile", () => {
  beforeEach(reset);

  it("removes the file from the list", async () => {
    mockIpc.readFile.mockResolvedValueOnce("x");
    await useEditorStore.getState().openFile("ws-1", "/repo/x.ts");
    useEditorStore.getState().closeFile("ws-1", "/repo/x.ts");
    expect(useEditorStore.getState().getFiles("ws-1")).toHaveLength(0);
  });

  it("active becomes null when last file is closed", async () => {
    mockIpc.readFile.mockResolvedValueOnce("x");
    await useEditorStore.getState().openFile("ws-1", "/repo/x.ts");
    useEditorStore.getState().closeFile("ws-1", "/repo/x.ts");
    expect(useEditorStore.getState().getActivePath("ws-1")).toBeNull();
  });

  it("active shifts to a neighbor when active file is closed", async () => {
    mockIpc.readFile
      .mockResolvedValueOnce("a")
      .mockResolvedValueOnce("b");
    await useEditorStore.getState().openFile("ws-1", "/repo/a.ts");
    await useEditorStore.getState().openFile("ws-1", "/repo/b.ts");

    useEditorStore.getState().closeFile("ws-1", "/repo/b.ts");
    expect(useEditorStore.getState().getActivePath("ws-1")).toBe("/repo/a.ts");
  });
});

describe("editorStore — setContent + isDirty", () => {
  beforeEach(reset);

  it("setContent marks the file dirty", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");

    expect(useEditorStore.getState().isDirty("ws-1", "/repo/foo.ts")).toBe(false);

    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "changed");
    expect(useEditorStore.getState().isDirty("ws-1", "/repo/foo.ts")).toBe(true);
  });

  it("setContent does not touch savedContent", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");
    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "changed");

    const file = useEditorStore.getState().getFiles("ws-1")[0];
    expect(file.savedContent).toBe("original");
    expect(file.content).toBe("changed");
  });
});

describe("editorStore — saveActive", () => {
  beforeEach(reset);

  it("calls writeFile and clears dirty flag", async () => {
    mockIpc.readFile.mockResolvedValueOnce("original");
    mockIpc.writeFile.mockResolvedValueOnce(undefined);

    await useEditorStore.getState().openFile("ws-1", "/repo/foo.ts");
    useEditorStore.getState().setContent("ws-1", "/repo/foo.ts", "saved-content");

    await useEditorStore.getState().saveActive("ws-1");

    expect(mockIpc.writeFile).toHaveBeenCalledWith("/repo/foo.ts", "saved-content");
    expect(useEditorStore.getState().isDirty("ws-1", "/repo/foo.ts")).toBe(false);
  });

  it("no-ops when no active file", async () => {
    await useEditorStore.getState().saveActive("ws-1");
    expect(mockIpc.writeFile).not.toHaveBeenCalled();
  });
});

describe("editorStore — workspace isolation", () => {
  beforeEach(reset);

  it("two workspaces have independent file lists", async () => {
    mockIpc.readFile
      .mockResolvedValueOnce("in ws-A")
      .mockResolvedValueOnce("in ws-B");

    await useEditorStore.getState().openFile("ws-A", "/repo/a.ts");
    await useEditorStore.getState().openFile("ws-B", "/repo/b.ts");

    expect(useEditorStore.getState().getFiles("ws-A")).toHaveLength(1);
    expect(useEditorStore.getState().getFiles("ws-B")).toHaveLength(1);
    expect(useEditorStore.getState().getActivePath("ws-A")).toBe("/repo/a.ts");
    expect(useEditorStore.getState().getActivePath("ws-B")).toBe("/repo/b.ts");
  });

  it("empty selectors return stable references", () => {
    const r1 = useEditorStore.getState().getFiles("never-seen-ws");
    const r2 = useEditorStore.getState().getFiles("never-seen-ws");
    expect(r1).toBe(r2); // same reference — no new array each call
  });
});
