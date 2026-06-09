import { describe, it, expect, vi, beforeEach } from "vitest";

const readFileChecked = vi.fn();
const writeFile = vi.fn();
const pushToast = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    readFileChecked: (...a: unknown[]) => readFileChecked(...a),
    writeFile: (...a: unknown[]) => writeFile(...a),
  },
}));
vi.mock("../components/Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));
vi.mock("../lib/editorLang", () => ({ langForExtension: () => "javascript" }));

import { useEditorStore } from "./editorStore";

function reset() {
  useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
  vi.clearAllMocks();
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
});
