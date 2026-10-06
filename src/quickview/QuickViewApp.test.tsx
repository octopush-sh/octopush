import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const hoisted = vi.hoisted(() => ({
  doc: "",
  eol: "",
  onChange: null as null | (() => void),
  confirmClose: null as null | (() => void),
  ipc: {
    quickviewPath: vi.fn(),
    readFileChecked: vi.fn(),
    workspaceForPath: vi.fn(),
    fileMeta: vi.fn(),
    writeFile: vi.fn(),
    revealInFinder: vi.fn(),
    openPathInWorkspace: vi.fn(),
    onCloseRequested: vi.fn(() => Promise.resolve(() => {})),
    onConfirmCloseRequest: vi.fn((h: () => void) => {
      hoisted.confirmClose = h;
      return Promise.resolve(() => {});
    }),
    onThemeBroadcast: vi.fn(() => Promise.resolve(() => {})),
    quickviewSetDirty: vi.fn(() => Promise.resolve()),
    showMainWindow: vi.fn(() => Promise.resolve()),
    destroyCurrentWindow: vi.fn(),
    getTheme: vi.fn(() => Promise.resolve(null)),
    listThemes: vi.fn(() => Promise.resolve([])),
  },
}));

vi.mock("../lib/ipc", () => ({ ipc: hoisted.ipc }));

// JSDOM can't run CodeMirror; a textarea stands in, exposing the same
// view-shaped handle Quick View reads the document through. Docs compare by
// content, like CodeMirror's `Text.eq`.
function fakeDoc(text: string) {
  return {
    text,
    length: text.length,
    lines: text.split("\n").length,
    eq: (o: { text: string }) => o.text === text,
  };
}
const fakeView = {
  get state() {
    return { doc: fakeDoc(hoisted.doc), lineBreak: hoisted.eol || "\n" };
  },
};

vi.mock("./QuickViewEditor", () => ({
  QuickViewEditor: ({
    doc,
    eol,
    onChange,
    onReady,
  }: {
    doc: string;
    eol: string;
    onChange: () => void;
    onReady: (v: unknown) => void;
  }) => {
    hoisted.eol = eol;
    hoisted.onChange = onChange;
    // Like the real editor, the `doc` prop seeds the buffer once.
    useState(() => {
      hoisted.doc = doc;
      onReady(fakeView);
      return null;
    });
    return (
      <textarea
        data-testid="editor"
        defaultValue={doc}
        onChange={(e) => {
          hoisted.doc = e.target.value;
          onChange();
        }}
      />
    );
  },
  docText: () => hoisted.doc,
  replaceDoc: (_v: unknown, text: string) => {
    hoisted.doc = text;
    hoisted.onChange?.();
  },
}));

vi.mock("../components/editor/MarkdownPreview", () => ({
  MarkdownPreview: ({ source }: { source: string }) => <div data-testid="md">{source}</div>,
}));

import { QuickViewApp } from "./QuickViewApp";

function openFile(path: string, content: string) {
  hoisted.ipc.quickviewPath.mockResolvedValue(path);
  hoisted.ipc.readFileChecked.mockResolvedValue({ kind: "text", content, size: content.length, mtime: 10 });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.ipc.workspaceForPath.mockResolvedValue(null);
  hoisted.ipc.fileMeta.mockResolvedValue({ mtimeMs: 10, size: 1 });
  hoisted.ipc.writeFile.mockResolvedValue({ mtime: 20 });
});

describe("QuickViewApp", () => {
  it("opens Markdown rendered, and switches to source", async () => {
    openFile("/notes/plan.md", "# Plan");
    render(<QuickViewApp />);
    expect(await screen.findByTestId("md")).toHaveTextContent("# Plan");
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.queryByTestId("md")).toBeNull();
    expect(screen.getByTestId("editor")).toBeVisible();
  });

  it("renders CSV as a table", async () => {
    openFile("/d/people.csv", "name,age\nAda,36\n");
    render(<QuickViewApp />);
    expect(await screen.findByRole("columnheader", { name: "name" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Ada" })).toBeInTheDocument();
  });

  it("saves edits with the external-change guard", async () => {
    openFile("/src/a.ts", "let a = 1;");
    render(<QuickViewApp />);
    const editor = await screen.findByTestId("editor");
    fireEvent.change(editor, { target: { value: "let a = 2;" } });
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    });
    expect(hoisted.ipc.writeFile).toHaveBeenCalledWith("/src/a.ts", "let a = 2;");
    await waitFor(() => expect(screen.queryByLabelText("Unsaved changes")).toBeNull());
  });

  it("refuses to overwrite a file changed on disk until told to", async () => {
    openFile("/src/a.ts", "x");
    hoisted.ipc.fileMeta.mockResolvedValue({ mtimeMs: 99, size: 1 });
    render(<QuickViewApp />);
    fireEvent.change(await screen.findByTestId("editor"), { target: { value: "y" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    });
    expect(hoisted.ipc.writeFile).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("changed on disk");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    });
    expect(hoisted.ipc.writeFile).toHaveBeenCalledWith("/src/a.ts", "y");
  });

  it("formats JSON and reports invalid JSON", async () => {
    openFile("/c/x.json", '{"a":1}');
    render(<QuickViewApp />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(hoisted.doc).toBe('{\n  "a": 1\n}');

    hoisted.doc = "{oops";
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(await screen.findByTitle(/Expected|Unexpected|position/)).toBeInTheDocument();
  });

  it("offers the workspace when the file belongs to one", async () => {
    openFile("/code/app/src/a.ts", "x");
    hoisted.ipc.workspaceForPath.mockResolvedValue({
      projectId: "p",
      workspaceId: "w",
      workspaceName: "feature",
      root: "/code/app",
    });
    hoisted.ipc.openPathInWorkspace.mockResolvedValue(true);
    render(<QuickViewApp />);
    expect(await screen.findByText("feature · src/a.ts")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue in the workspace" }));
    });
    expect(hoisted.ipc.openPathInWorkspace).toHaveBeenCalledWith("/code/app/src/a.ts");
  });

  it("clears the unsaved mark when edits are undone back to the original", async () => {
    openFile("/src/a.ts", "one");
    render(<QuickViewApp />);
    const editor = await screen.findByTestId("editor");
    fireEvent.change(editor, { target: { value: "two" } });
    expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    await waitFor(() => expect(hoisted.ipc.quickviewSetDirty).toHaveBeenLastCalledWith(true));
    fireEvent.change(editor, { target: { value: "one" } });
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
    await waitFor(() => expect(hoisted.ipc.quickviewSetDirty).toHaveBeenLastCalledWith(false));
  });

  it("keeps a CRLF file's line endings", async () => {
    openFile("/w/notes.txt", "a\r\nb\r\n");
    render(<QuickViewApp />);
    await screen.findByTestId("editor");
    expect(hoisted.eol).toBe("\r\n");
  });

  it("formats JSON in the file's own line endings", async () => {
    openFile("/c/x.json", '{"a":1}\r\n');
    render(<QuickViewApp />);
    await screen.findByTestId("editor");
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(hoisted.doc).toBe('{\r\n  "a": 1\r\n}\r\n');
  });

  it("asks before an app quit drops unsaved edits", async () => {
    openFile("/src/a.ts", "x");
    render(<QuickViewApp />);
    fireEvent.change(await screen.findByTestId("editor"), { target: { value: "y" } });
    act(() => hoisted.confirmClose?.());
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
  });

  it("always offers the way back to the main window", async () => {
    openFile("/notes/a.md", "x");
    render(<QuickViewApp />);
    await screen.findByTestId("md");
    fireEvent.click(screen.getByRole("button", { name: "Open Octopush" }));
    expect(hoisted.ipc.showMainWindow).toHaveBeenCalled();
  });

  it("explains files it cannot show", async () => {
    hoisted.ipc.quickviewPath.mockResolvedValue("/bin/tool");
    hoisted.ipc.readFileChecked.mockResolvedValue({ kind: "binary", size: 10, mtime: 1 });
    render(<QuickViewApp />);
    expect(await screen.findByText("Nothing to show here.")).toBeInTheDocument();
    const reveal = screen.getAllByRole("button", { name: /Finder|Explorer|folder/ });
    fireEvent.click(reveal[reveal.length - 1]);
    expect(hoisted.ipc.revealInFinder).toHaveBeenCalledWith("/bin/tool");
  });
});
