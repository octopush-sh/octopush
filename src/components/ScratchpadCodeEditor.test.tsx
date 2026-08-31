import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";

// Shared ref so tests can reach the live EditorView mock instance.
const hoisted = vi.hoisted(() => ({
  lastView: null as null | { dispatch: ReturnType<typeof vi.fn> },
}));

// ─── Mock CodeMirror (JSDOM can't construct a real EditorView) ────────
vi.mock("@codemirror/view", () => {
  class EditorViewMock {
    dom = document.createElement("div");
    destroy = vi.fn();
    dispatch = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: any) {
      // Mirror the real EditorView: attach our DOM to the parent host so the
      // editor surface is present in the rendered tree.
      config?.parent?.appendChild?.(this.dom);
      hoisted.lastView = this;
    }
    static updateListener = { of: vi.fn(() => ({})) };
    static theme = vi.fn(() => ({}));
  }
  return {
    EditorView: EditorViewMock,
    lineNumbers: vi.fn(() => ({})),
    highlightActiveLineGutter: vi.fn(() => ({})),
    highlightActiveLine: vi.fn(() => ({})),
    drawSelection: vi.fn(() => ({})),
    keymap: { of: vi.fn(() => ({})) },
    placeholder: vi.fn(() => ({})),
  };
});

vi.mock("@codemirror/state", () => {
  class CompartmentMock {
    of = vi.fn((v: unknown) => ({ compartment: v }));
    reconfigure = vi.fn((v: unknown) => ({ reconfigure: v }));
  }
  return {
    EditorState: {
      create: vi.fn().mockReturnValue({ doc: { toString: () => "" } }),
    },
    Compartment: CompartmentMock,
  };
});

vi.mock("@codemirror/search", () => ({
  search: vi.fn(() => ({})),
  // Mirrors the real keymap's shape closely enough to test precedence: it also
  // binds Mod-f (to openSearchPanel), so ours has to come FIRST. An empty array
  // here made the ordering assertion vacuous.
  searchKeymap: [
    { key: "Mod-f", run: () => true, __builtin: true },
    { key: "Mod-g", run: () => true, __builtin: true },
    { key: "F3", run: () => true, __builtin: true },
    { key: "Mod-d", run: () => true, __builtin: true },
    { key: "Mod-Alt-g", run: () => true, __builtin: true },
  ],
  setSearchQuery: { of: vi.fn((q: unknown) => ({ query: q })) },
  SearchQuery: class {
    search: string;
    constructor(opts: { search?: string }) { this.search = opts.search ?? ""; }
  },
}));

vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  indentWithTab: {},
  history: vi.fn(() => ({})),
  historyKeymap: [],
}));

vi.mock("@codemirror/language", () => ({
  indentOnInput: vi.fn(() => ({})),
  bracketMatching: vi.fn(() => ({})),
}));

const langMock = () => ({ javascript: vi.fn(() => ({})) });
vi.mock("@codemirror/lang-javascript", () => ({ javascript: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-rust", () => ({ rust: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-python", () => ({ python: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-java", () => ({ java: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-json", () => ({ json: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-markdown", () => ({ markdown: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-html", () => ({ html: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-css", () => ({ css: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-xml", () => ({ xml: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-yaml", () => ({ yaml: vi.fn(() => ({})) }));
void langMock;

vi.mock("./editor/atelierTheme", () => ({
  buildEditorTheme: vi.fn(() => []),
}));

// Builds its decorations at import time, so it needs the real @codemirror/view
// which this file replaces with a stub. Behaviour lives in
// editor/searchHighlight.test.ts; the marker lets us assert it stays wired in.
vi.mock("./editor/searchHighlight", () => ({
  searchMatchHighlight: { __searchMatchHighlight: true },
}));
// Builds decorations at import time against the real @codemirror/view this
// file stubs out — same reason as searchHighlight above.
vi.mock("./editor/symbolHighlight", () => ({
  symbolOccurrenceHighlight: { __symbolOccurrenceHighlight: true },
}));

// The overlay is only mounted after ⌘F; these tests don't open it.
vi.mock("./editor/EditorSearch", () => ({
  EditorSearch: () => <div data-testid="scratchpad-find" />,
}));

import { ScratchpadCodeEditor } from "./ScratchpadCodeEditor";
import { useScratchpadStore } from "../stores/scratchpadStore";

describe("ScratchpadCodeEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScratchpadStore.getState().reset();
  });

  it("shows the empty state when no tab is active", () => {
    const { getByText } = render(<ScratchpadCodeEditor />);
    expect(getByText("No tab selected")).toBeInTheDocument();
  });

  it("renders the CodeMirror host when a tab is active", () => {
    useScratchpadStore.getState().createTab();
    const { getByTestId } = render(<ScratchpadCodeEditor />);
    expect(getByTestId("scratchpad-host")).toBeInTheDocument();
  });

  it("REGRESSION: renders a single editor layer — no textarea/pre overlay", () => {
    // The old hand-rolled editor stacked an invisible <textarea> over a
    // highlighted <pre>, which caused the double-text / shadow bug. The
    // CodeMirror rewrite must render exactly one editing surface and neither
    // of the old overlay elements.
    useScratchpadStore.getState().createTab();
    const { container } = render(<ScratchpadCodeEditor />);

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelectorAll("[data-testid='scratchpad-host']")).toHaveLength(1);
  });

  it("creates the editor with the active tab's content as the document", async () => {
    const { EditorState } = await import("@codemirror/state");
    const store = useScratchpadStore.getState();
    store.createTab();
    const tabId = useScratchpadStore.getState().tabs[0].id;
    store.setContent(tabId, "const x = 1;");

    render(<ScratchpadCodeEditor />);

    expect(EditorState.create).toHaveBeenCalledWith(
      expect.objectContaining({ doc: "const x = 1;" }),
    );
  });

  describe("find in scratchpad", () => {
    /** The bindings ScratchpadCodeEditor handed to `keymap.of`. */
    async function bindings() {
      const { keymap } = await import("@codemirror/view");
      const call = vi.mocked(keymap.of).mock.calls.at(-1);
      expect(call).toBeDefined();
      return call![0] as { key: string; run: () => boolean }[];
    }

    async function extensions() {
      const { EditorState } = await import("@codemirror/state");
      const call = vi.mocked(EditorState.create).mock.calls.at(-1) as
        | [{ extensions: unknown[] }]
        | undefined;
      expect(call).toBeDefined();
      return call![0].extensions;
    }

    function withTab() {
      useScratchpadStore.getState().createTab();
      return render(<ScratchpadCodeEditor />);
    }

    it("registers the search extension and our match highlighter", async () => {
      withTab();
      const { search } = await import("@codemirror/search");
      expect(search).toHaveBeenCalledWith({ top: true });
      // Without the plugin nothing paints, since the built-in highlighter needs
      // its own docked panel open and ⌘F keeps that closed.
      expect(await extensions()).toContainEqual({ __searchMatchHighlight: true });
    });

    it("binds ⌘F before searchKeymap's own Mod-f, so the Atelier overlay wins", async () => {
      withTab();
      const keys = (await bindings()) as ({ key: string; __builtin?: boolean })[];
      const ours = keys.findIndex((b) => b?.key === "Mod-f" && !b.__builtin);
      const builtin = keys.findIndex((b) => b?.key === "Mod-f" && b.__builtin);
      expect(ours).toBeGreaterThanOrEqual(0);
      // Both exist; CodeMirror runs bindings in insertion order and stops at the
      // first that returns true, so ours must be earlier or ⌘F would open the
      // library's docked panel instead of the overlay.
      expect(builtin).toBeGreaterThanOrEqual(0);
      expect(ours).toBeLessThan(builtin);
    });

    it("keeps searchKeymap's next/prev bindings, which FEATURES.md advertises", async () => {
      withTab();
      const keys = (await bindings()) as ({ key: string })[];
      for (const key of ["Mod-g", "F3", "Mod-d", "Mod-Alt-g"]) {
        expect(keys.some((b) => b?.key === key), key).toBe(true);
      }
    });

    it("anchors the overlay so it can position itself", async () => {
      // EditorSearch is `absolute right-3 top-3`; without a positioned ancestor
      // it escapes to the nearest one and lands somewhere else entirely.
      const { container } = withTab();
      const modF = (await bindings()).find((b) => b.key === "Mod-f")!;
      act(() => { modF.run(); });
      const anchor = container.querySelector("[data-testid=scratchpad-host]")!
        .parentElement!;
      expect(anchor.className).toContain("relative");
    });

    it("⌘F opens the find overlay", async () => {
      const { queryByTestId, getByTestId } = withTab();
      expect(queryByTestId("scratchpad-find")).toBeNull();
      const modF = (await bindings()).find((b) => b.key === "Mod-f")!;
      act(() => {
        expect(modF.run()).toBe(true);
      });
      expect(getByTestId("scratchpad-find")).toBeInTheDocument();
    });

    it("closes find and clears the query when the scratchpad is hidden", async () => {
      // CanvasSplit keeps both columns mounted, so hiding doesn't unmount us —
      // without this the card and its washed matches come back on reopen.
      // toggleOpen from the store's default (isOpen: false) would OPEN it, so
      // open first — and it creates the tab for us.
      useScratchpadStore.getState().toggleOpen();
      const { queryByTestId } = render(<ScratchpadCodeEditor />);
      expect(useScratchpadStore.getState().isOpen).toBe(true);
      const modF = (await bindings()).find((b) => b.key === "Mod-f")!;
      act(() => { modF.run(); });
      expect(queryByTestId("scratchpad-find")).toBeInTheDocument();

      const view = hoisted.lastView!;
      view.dispatch.mockClear();
      await act(async () => { useScratchpadStore.getState().toggleOpen(); });
      expect(queryByTestId("scratchpad-find")).toBeNull();
      expect(view.dispatch).toHaveBeenCalledWith({
        effects: { query: expect.objectContaining({ search: "" }) },
      });
    });

    it("closes find when a rename changes the language, since that rebuilds the view", async () => {
      // renameTab re-detects the language from the new name, so a rename hits the
      // rebuild effect. The overlay used to survive it holding the DESTROYED
      // view, where CodeMirror silently ignores every dispatch — a Replace All
      // would mutate nothing and never reach the store.
      const { queryByTestId } = withTab();
      const tabId = useScratchpadStore.getState().tabs[0].id;
      const modF = (await bindings()).find((b) => b.key === "Mod-f")!;
      act(() => { modF.run(); });
      expect(queryByTestId("scratchpad-find")).toBeInTheDocument();
      await act(async () => {
        useScratchpadStore.getState().renameTab(tabId, "notes.py");
      });
      expect(useScratchpadStore.getState().tabs[0].language).toBe("python");
      expect(queryByTestId("scratchpad-find")).toBeNull();
    });

    it("closes the overlay when the tab changes, since the view is rebuilt", async () => {
      const { queryByTestId } = withTab();
      const modF = (await bindings()).find((b) => b.key === "Mod-f")!;
      act(() => { modF.run(); });
      expect(queryByTestId("scratchpad-find")).toBeInTheDocument();
      await act(async () => { useScratchpadStore.getState().createTab(); });
      expect(queryByTestId("scratchpad-find")).toBeNull();
    });

    it("repaints on octo:theme, so match colours follow the active theme", async () => {
      // This editor used to take the static `atelierTheme`, resolved at import —
      // which froze the match tokens on the atelier fallbacks regardless of the
      // real theme. It's now a compartment, reconfigured on the theme event.
      withTab();
      // The theme has to be INSIDE a compartment for the reconfigure to reach
      // it — dispatching at a theme that was added directly is a no-op.
      expect(await extensions()).toContainEqual({ compartment: [] });

      const view = hoisted.lastView!;
      view.dispatch.mockClear();
      act(() => { window.dispatchEvent(new CustomEvent("octo:theme")); });
      expect(view.dispatch).toHaveBeenCalledTimes(1);
      const arg = view.dispatch.mock.calls[0][0] as { effects?: unknown };
      expect(arg.effects).toEqual({ reconfigure: [] });
    });
  });
});
