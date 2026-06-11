import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileChecked = vi.fn();
const writeFile = vi.fn();
const fileMeta = vi.fn();
const pushToast = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    readFileChecked: (...a: unknown[]) => readFileChecked(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
    fileMeta: (...a: unknown[]) => fileMeta(...a),
  },
}));
vi.mock("../components/Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));
vi.mock("../lib/editorLang", () => ({ langForExtension: () => "javascript" }));

import { useEditorStore } from "./editorStore";

function reset() {
  useEditorStore.setState({ filesByWs: {}, activeByWs: {}, saveConflict: null });
  vi.clearAllMocks();
  // Default: disk matches the tracked state (no external change).
  fileMeta.mockResolvedValue({ mtimeMs: 100, size: 2 });
}

describe("editorStore.openFile", () => {
  beforeEach(reset);

  it("opens a text file with content, mtime and size", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "hi", size: 2, mtime: 111 });
    await useEditorStore.getState().openFile("ws", "/a.ts");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f).toMatchObject({ path: "/a.ts", content: "hi", savedContent: "hi", kind: "text", mtime: 111, size: 2 });
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(false);
  });

  it("opens a binary file with no content and is never dirty", async () => {
    readFileChecked.mockResolvedValue({ kind: "binary", size: 1000, mtime: 5 });
    await useEditorStore.getState().openFile("ws", "/x.war");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f).toMatchObject({ kind: "binary", binaryReason: "binary", content: "", size: 1000 });
    expect(useEditorStore.getState().isDirty("ws", "/x.war")).toBe(false);
  });

  it("maps unsupportedEncoding to a binary file with that reason", async () => {
    readFileChecked.mockResolvedValue({ kind: "unsupportedEncoding", size: 4, mtime: 5 });
    await useEditorStore.getState().openFile("ws", "/x.bin");
    expect(useEditorStore.getState().getFiles("ws")[0]).toMatchObject({
      kind: "binary", binaryReason: "unsupportedEncoding",
    });
  });

  it("prompts before opening a large text file; declining opens nothing", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "big", size: 5_000_000, mtime: 1 });
    const confirm = vi.fn().mockResolvedValue(false);
    await useEditorStore.getState().openFile("ws", "/big.ts", confirm);
    expect(confirm).toHaveBeenCalledWith(5_000_000, "/big.ts");
    expect(useEditorStore.getState().getFiles("ws")).toHaveLength(0);
  });

  it("re-reads a tooLarge file (cap raised) when the user confirms", async () => {
    readFileChecked
      .mockResolvedValueOnce({ kind: "tooLarge", size: 99_000_000 })
      .mockResolvedValueOnce({ kind: "text", content: "huge", size: 99_000_000, mtime: 2 });
    const confirm = vi.fn().mockResolvedValue(true);
    await useEditorStore.getState().openFile("ws", "/huge.log", confirm);
    expect(readFileChecked).toHaveBeenNthCalledWith(2, "/huge.log", Number.MAX_SAFE_INTEGER);
    expect(useEditorStore.getState().getFiles("ws")[0]).toMatchObject({ kind: "text", content: "huge" });
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("editorStore.saveActive", () => {
  beforeEach(reset);

  async function openText() {
    readFileChecked.mockResolvedValue({ kind: "text", content: "v1", size: 2, mtime: 100 });
    await useEditorStore.getState().openFile("ws", "/a.ts");
  }

  it("updates savedContent + mtime on success", async () => {
    await openText();
    useEditorStore.getState().setContent("ws", "/a.ts", "v2");
    writeFile.mockResolvedValue({ mtime: 200 });
    await useEditorStore.getState().saveActive("ws");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.savedContent).toBe("v2");
    expect(f.mtime).toBe(200);
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(false);
  });

  it("toasts on write failure and leaves the file dirty", async () => {
    await openText();
    useEditorStore.getState().setContent("ws", "/a.ts", "v2");
    writeFile.mockRejectedValue(new Error("permission denied"));
    await useEditorStore.getState().saveActive("ws");
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(true);
  });

  it("marks only the written content as saved — typing during the write stays dirty", async () => {
    await openText();
    useEditorStore.getState().setContent("ws", "/a.ts", "v2");

    let resolveWrite!: (v: { mtime: number }) => void;
    writeFile.mockReturnValue(new Promise((r) => { resolveWrite = r; }));

    const save = useEditorStore.getState().saveActive("ws", { force: true });
    expect(writeFile).toHaveBeenCalledWith("/a.ts", "v2"); // write in flight

    // The user keeps typing while the write awaits.
    useEditorStore.getState().setContent("ws", "/a.ts", "v2 + typed during write");

    resolveWrite({ mtime: 300 });
    await save;

    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.savedContent).toBe("v2");                    // what actually hit disk
    expect(f.content).toBe("v2 + typed during write");    // buffer untouched
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(true);
  });
});

describe("editorStore.saveActive — external-change guard", () => {
  beforeEach(reset);

  async function openText() {
    readFileChecked.mockResolvedValue({ kind: "text", content: "v1", size: 2, mtime: 100 });
    await useEditorStore.getState().openFile("ws", "/a.ts");
    useEditorStore.getState().setContent("ws", "/a.ts", "v2");
  }

  it("blocks the save, records a conflict and flags diskStale when the disk is newer", async () => {
    await openText();
    fileMeta.mockResolvedValue({ mtimeMs: 999, size: 2 });
    await useEditorStore.getState().saveActive("ws");
    expect(writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().saveConflict).toMatchObject({ path: "/a.ts", kind: "changed" });
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(true);
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(true);
  });

  it("blocks the save when the disk mtime differs in either direction (e.g. checkout to an older commit)", async () => {
    await openText(); // tracked mtime 100
    fileMeta.mockResolvedValue({ mtimeMs: 50, size: 2 }); // older than tracked
    await useEditorStore.getState().saveActive("ws");
    expect(writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().saveConflict).toMatchObject({ path: "/a.ts", kind: "changed" });
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(true);
  });

  it("records a deleted conflict, flags diskStale and skips the write when the file is gone", async () => {
    await openText();
    fileMeta.mockResolvedValue(null);
    await useEditorStore.getState().saveActive("ws");
    expect(writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().saveConflict).toMatchObject({ path: "/a.ts", kind: "deleted" });
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(true);
  });

  it("dismissing the conflict (Keep editing / Escape) keeps the buffer intact with diskStale as the signal", async () => {
    await openText(); // buffer content "v2", unsaved
    fileMeta.mockResolvedValue({ mtimeMs: 999, size: 2 });
    await useEditorStore.getState().saveActive("ws");
    expect(useEditorStore.getState().saveConflict).not.toBeNull();

    // Escape in the dialog maps to onCancel, which only clears the conflict.
    useEditorStore.getState().clearSaveConflict();

    expect(useEditorStore.getState().saveConflict).toBeNull();
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.content).toBe("v2");          // edits intact
    expect(f.diskStale).toBe(true);        // persistent status-bar chip
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("force save skips the disk check and writes", async () => {
    await openText();
    fileMeta.mockResolvedValue({ mtimeMs: 999, size: 2 }); // would conflict
    writeFile.mockResolvedValue({ mtime: 1000 });
    await useEditorStore.getState().saveActive("ws", { force: true });
    expect(fileMeta).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith("/a.ts", "v2");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.savedContent).toBe("v2");
    expect(f.mtime).toBe(1000);
    expect(useEditorStore.getState().saveConflict).toBeNull();
  });

  it("clearSaveConflict resets the conflict", async () => {
    await openText();
    fileMeta.mockResolvedValue(null);
    await useEditorStore.getState().saveActive("ws");
    expect(useEditorStore.getState().saveConflict).not.toBeNull();
    useEditorStore.getState().clearSaveConflict();
    expect(useEditorStore.getState().saveConflict).toBeNull();
  });

  it("a successful save clears the disk-stale flag", async () => {
    await openText();
    // Flag the buffer stale (dirty + disk changed on focus) ...
    fileMeta.mockResolvedValue({ mtimeMs: 500, size: 2 });
    await useEditorStore.getState().checkActiveAgainstDisk("ws");
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(true);
    // ... then force-save over it.
    writeFile.mockResolvedValue({ mtime: 600 });
    await useEditorStore.getState().saveActive("ws", { force: true });
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(false);
  });
});

describe("editorStore.reloadFromDisk", () => {
  beforeEach(reset);

  it("replaces the buffer, clears dirty and bumps the version", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "v1", size: 2, mtime: 100 });
    await useEditorStore.getState().openFile("ws", "/a.ts");
    useEditorStore.getState().setContent("ws", "/a.ts", "local edits");

    readFileChecked.mockResolvedValue({ kind: "text", content: "disk", size: 4, mtime: 500 });
    const ok = await useEditorStore.getState().reloadFromDisk("ws", "/a.ts");
    expect(ok).toBe(true);
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f).toMatchObject({
      content: "disk", savedContent: "disk", mtime: 500, size: 4, diskStale: false,
    });
    expect(f.version).toBe(1);
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(false);
  });

  it("toasts and leaves the buffer intact when the re-read fails", async () => {
    readFileChecked.mockResolvedValue({ kind: "text", content: "v1", size: 2, mtime: 100 });
    await useEditorStore.getState().openFile("ws", "/a.ts");

    readFileChecked.mockRejectedValue(new Error("gone"));
    const ok = await useEditorStore.getState().reloadFromDisk("ws", "/a.ts");
    expect(ok).toBe(false);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    expect(useEditorStore.getState().getFiles("ws")[0].content).toBe("v1");
  });
});

describe("editorStore.reorderFiles", () => {
  beforeEach(reset);

  async function openThree() {
    readFileChecked.mockImplementation((path: unknown) =>
      Promise.resolve({ kind: "text", content: String(path), size: 2, mtime: 1 }),
    );
    await useEditorStore.getState().openFile("ws", "/a.ts");
    await useEditorStore.getState().openFile("ws", "/b.ts");
    await useEditorStore.getState().openFile("ws", "/c.ts");
  }

  const order = () => useEditorStore.getState().getFiles("ws").map((f) => f.path);

  it("moves a tab forward (drag right)", async () => {
    await openThree();
    useEditorStore.getState().reorderFiles("ws", 0, 2);
    expect(order()).toEqual(["/b.ts", "/c.ts", "/a.ts"]);
  });

  it("moves a tab backward (drag left)", async () => {
    await openThree();
    useEditorStore.getState().reorderFiles("ws", 2, 0);
    expect(order()).toEqual(["/c.ts", "/a.ts", "/b.ts"]);
  });

  it("ignores no-op and out-of-range indices", async () => {
    await openThree();
    useEditorStore.getState().reorderFiles("ws", 1, 1);
    useEditorStore.getState().reorderFiles("ws", -1, 2);
    useEditorStore.getState().reorderFiles("ws", 0, 3);
    expect(order()).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  });

  it("does not touch the active path or other workspaces", async () => {
    await openThree();
    useEditorStore.getState().setActive("ws", "/b.ts");
    useEditorStore.getState().reorderFiles("ws", 0, 2);
    expect(useEditorStore.getState().getActivePath("ws")).toBe("/b.ts");
    expect(useEditorStore.getState().getFiles("ws-other")).toEqual([]);
  });
});

describe("editorStore.checkActiveAgainstDisk", () => {
  beforeEach(reset);

  async function openText() {
    readFileChecked.mockResolvedValue({ kind: "text", content: "v1", size: 2, mtime: 100 });
    await useEditorStore.getState().openFile("ws", "/a.ts");
  }

  it("silently reloads a clean buffer when the disk changed", async () => {
    await openText();
    fileMeta.mockResolvedValue({ mtimeMs: 500, size: 4 });
    readFileChecked.mockResolvedValue({ kind: "text", content: "disk", size: 4, mtime: 500 });

    await useEditorStore.getState().checkActiveAgainstDisk("ws");
    expect(readFileChecked).toHaveBeenCalledTimes(2); // open + reload
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f).toMatchObject({ content: "disk", savedContent: "disk", mtime: 500 });
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(false);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "info" }));
    expect(useEditorStore.getState().saveConflict).toBeNull();
  });

  it("flags diskStale on a dirty buffer — no write, no reload, no dialog", async () => {
    await openText();
    useEditorStore.getState().setContent("ws", "/a.ts", "local");
    fileMeta.mockResolvedValue({ mtimeMs: 500, size: 2 });

    await useEditorStore.getState().checkActiveAgainstDisk("ws");
    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.diskStale).toBe(true);
    expect(f.content).toBe("local");
    expect(readFileChecked).toHaveBeenCalledTimes(1); // only the open — no reload
    expect(writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().saveConflict).toBeNull();
  });

  it("does nothing when the disk mtime matches", async () => {
    await openText();
    fileMeta.mockResolvedValue({ mtimeMs: 100, size: 2 });
    await useEditorStore.getState().checkActiveAgainstDisk("ws");
    expect(readFileChecked).toHaveBeenCalledTimes(1);
    expect(pushToast).not.toHaveBeenCalled();
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale ?? false).toBe(false);
  });

  it("flags diskStale when the file was deleted on disk", async () => {
    await openText();
    fileMeta.mockResolvedValue(null);
    await useEditorStore.getState().checkActiveAgainstDisk("ws");
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(true);
    expect(readFileChecked).toHaveBeenCalledTimes(1);
  });

  it("typing while the stat is in flight: dirtiness is judged at resolve time — no silent reload", async () => {
    await openText(); // clean buffer, mtime 100

    let resolveMeta!: (v: { mtimeMs: number; size: number }) => void;
    fileMeta.mockReturnValue(new Promise((r) => { resolveMeta = r; }));

    const check = useEditorStore.getState().checkActiveAgainstDisk("ws");
    // The user types while the stat awaits — the buffer is dirty now.
    useEditorStore.getState().setContent("ws", "/a.ts", "typed during stat");

    resolveMeta({ mtimeMs: 500, size: 4 }); // disk changed externally too
    await check;

    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.content).toBe("typed during stat"); // never clobbered
    expect(f.diskStale).toBe(true);              // quiet signal instead
    expect(readFileChecked).toHaveBeenCalledTimes(1); // only the open — no reload
  });

  it("typing while the silent reload's disk read is in flight: content is not clobbered", async () => {
    await openText(); // clean buffer, mtime 100
    fileMeta.mockResolvedValue({ mtimeMs: 500, size: 4 });

    let resolveRead!: (v: unknown) => void;
    readFileChecked.mockReturnValue(new Promise((r) => { resolveRead = r; }));

    const check = useEditorStore.getState().checkActiveAgainstDisk("ws");
    // Let the stat resolve and the reload start (buffer still clean at the gate).
    await Promise.resolve();
    await Promise.resolve();
    expect(readFileChecked).toHaveBeenCalledTimes(2); // open + reload in flight

    // The user types while the disk read awaits.
    useEditorStore.getState().setContent("ws", "/a.ts", "typed during read");

    resolveRead({ kind: "text", content: "disk", size: 4, mtime: 500 });
    await check;

    const f = useEditorStore.getState().getFiles("ws")[0];
    expect(f.content).toBe("typed during read"); // keystrokes preserved
    expect(f.savedContent).toBe("v1");           // still dirty vs. the old save
    expect(f.diskStale).toBe(true);              // flagged instead of swapped
    expect(useEditorStore.getState().isDirty("ws", "/a.ts")).toBe(true);
    // No "Reloaded" toast for a reload that did not happen.
    expect(pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ level: "info" }));
  });

  it("clears a stale flag once the disk matches again", async () => {
    await openText();
    useEditorStore.getState().setContent("ws", "/a.ts", "local");
    fileMeta.mockResolvedValue({ mtimeMs: 500, size: 2 });
    await useEditorStore.getState().checkActiveAgainstDisk("ws");
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(true);

    // External tool restored the tracked state (e.g. checkout back).
    fileMeta.mockResolvedValue({ mtimeMs: 100, size: 2 });
    await useEditorStore.getState().checkActiveAgainstDisk("ws");
    expect(useEditorStore.getState().getFiles("ws")[0].diskStale).toBe(false);
  });
});
