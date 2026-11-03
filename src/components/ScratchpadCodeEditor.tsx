import { useCallback, useEffect, useRef, useState } from "react";
import {
  EditorView,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  drawSelection,
  keymap,
  placeholder,
} from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import {
  defaultKeymap,
  indentWithTab,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { search, searchKeymap, setSearchQuery, SearchQuery } from "@codemirror/search";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { buildEditorTheme } from "./editor/atelierTheme";
import { EditorSearch } from "./editor/EditorSearch";
import { searchMatchHighlight } from "./editor/searchHighlight";
import { symbolOccurrenceHighlight } from "./editor/symbolHighlight";
import { useScratchpadStore } from "../stores/scratchpadStore";
import { loadLanguageSupport, loadedLanguageSupport } from "../lib/editorLanguages";
import type { LangId } from "../lib/editorLang";

/**
 * Maps a scratchpad tab's language id (`detectLanguageFromName`) to the
 * grammar it is highlighted with. The grammars are the shared lazy ones in
 * `editorLanguages.ts`. Languages outside this list stay plain text (plain
 * editing, no highlighting) — the editor stays fully usable.
 *
 * Exported for unit testing.
 */
export function scratchpadLang(lang: string): LangId {
  switch (lang) {
    // Scratchpad tabs don't tell JSX apart: both dialects allow it.
    case "javascript":
      return "jsx";
    case "typescript":
      return "tsx";
    case "python":
    case "rust":
    case "java":
    case "json":
    case "markdown":
    case "html":
    case "css":
    case "xml":
    case "yaml":
      return lang;
    case "scss":
    case "sass":
    case "less":
      return "css";
    default:
      return "plaintext";
  }
}

// Italic-serif placeholder + full-height layout, layered on top of the shared
// Atelier theme.
const scratchpadLayout = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-placeholder": {
    color: "var(--color-octo-brass)",
  },
});

/** Swapped on `octo:theme` so the editor repaints with the rest of the app.
 *  Module-level and stable, as in EditorPane — there is only ever one
 *  scratchpad editor mounted. */
const themeComp = new Compartment();
// Grammars load on first use (editorLanguages.ts): the editor opens with
// whatever has landed and is reconfigured once the grammar does.
const langComp = new Compartment();

export function ScratchpadCodeEditor() {
  const isOpen = useScratchpadStore((s) => s.isOpen);
  const activeTabId = useScratchpadStore((s) => s.activeTabId);
  const tabs = useScratchpadStore((s) => s.tabs);
  const setContent = useScratchpadStore((s) => s.setContent);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeLanguage = activeTab?.language ?? "plaintext";

  const hostRef = useRef<HTMLDivElement>(null);
  // The view is held BOTH as state and as a ref, deliberately.
  //
  // State, because the overlay is rendered from it: this editor destroys and
  // recreates its view on every tab switch and language change, and a ref
  // mutation doesn't re-render — the overlay would go on dispatching into a
  // destroyed view, which CodeMirror silently ignores (EditorView.update returns
  // early when `destroyed`), so a Replace All would vanish with no error at all.
  // The close-on-rebuild effect below also prevents that, and in fact masks it,
  // so no test distinguishes the two forms today; this is the structural guard
  // for a rebuild path added later without updating that effect's deps.
  //
  // Ref, because the `octo:theme` listener registers once and would otherwise
  // capture the first view forever.
  const [view, setView] = useState<EditorView | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Find/replace overlay, same component and behaviour as the REVIEW editor.
  // searchNonce is bumped on every ⌘F so an already-open overlay refocuses and
  // selects its query instead of silently no-op'ing.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchNonce, setSearchNonce] = useState(0);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!activeTabId || !hostRef.current) return;

    // Read the current content directly from the store at (re)create time so a
    // tab switch loads that tab's saved content. We deliberately do NOT depend
    // on `content` here — that would rebuild the editor on every keystroke and
    // reset the cursor/undo history.
    const initialContent =
      useScratchpadStore.getState().tabs.find((t) => t.id === activeTabId)
        ?.content ?? "";
    const lang = scratchpadLang(activeLanguage);

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        placeholder("Paste code here, or start typing…"),
        // Query state, commands and keymap. The match marks come from
        // searchMatchHighlight, not from here — the built-in highlighter only
        // runs while its own docked panel is open, which the ⌘F binding below
        // keeps closed. See editor/searchHighlight.ts.
        search({ top: true }),
        searchMatchHighlight,
        // Same ambient occurrence highlighting as the REVIEW editor. Only the
        // highlight, not ⌘-click: a scratchpad tab has no workspace to resolve
        // a definition against.
        symbolOccurrenceHighlight,
        keymap.of([
          // Before searchKeymap so ⌘F opens the Atelier overlay rather than
          // CodeMirror's docked panel, while ⌘G/F3 still find next/prev.
          { key: "Mod-f", run: () => { openSearch(); return true; } },
          indentWithTab,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        langComp.of(loadedLanguageSupport(lang) ?? []),
        themeComp.of(buildEditorTheme()),
        scratchpadLayout,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setContent(activeTabId, update.state.doc.toString());
          }
        }),
      ],
    });

    const created = new EditorView({ state, parent: hostRef.current });
    viewRef.current = created;
    setView(created);
    if (!loadedLanguageSupport(lang)) {
      void loadLanguageSupport(lang).then((support) => {
        if (viewRef.current === created) created.dispatch({ effects: langComp.reconfigure(support) });
      });
    }

    return () => {
      created.destroy();
      viewRef.current = null;
      setView(null);
    };
    // Rebuild only when the active tab or its language changes — not on content
    // edits (handled live by the update listener above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeLanguage]);

  // Follow Octopush theme switches. This editor used to take the static
  // `atelierTheme`, resolved once at import — which froze it on whatever was on
  // :root at module load, i.e. the atelier fallbacks, since themeStore.load() is
  // async. Harmless-looking, but it also froze the search-match tokens, so a hit
  // would have been washed in atelier brass over (say) vellum's cream.
  useEffect(() => {
    const onTheme = () => {
      viewRef.current?.dispatch({
        effects: themeComp.reconfigure(buildEditorTheme()),
      });
    };
    window.addEventListener("octo:theme", onTheme);
    return () => window.removeEventListener("octo:theme", onTheme);
  }, []);

  // Close the overlay whenever the view is rebuilt — the query and its
  // highlights go with the old view. `activeLanguage` is in here for a reason:
  // renaming a tab re-detects the language from the new name
  // (scratchpadStore.renameTab), so a rename is a rebuild too.
  useEffect(() => {
    setSearchOpen(false);
  }, [activeTabId, activeLanguage]);

  // Hiding the scratchpad doesn't unmount it (CanvasSplit keeps both columns in
  // the DOM), so without this the overlay would still be open — with its matches
  // still washed — when the panel is reopened later.
  useEffect(() => {
    if (isOpen) return;
    setSearchOpen(false);
    viewRef.current?.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "" })),
    });
  }, [isOpen]);

  if (!activeTab) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-octo-onyx">
        <p className="font-serif text-octo-mute">No tab selected</p>
      </div>
    );
  }

  return (
    // `relative` anchors the find overlay, which positions itself top-right.
    <div className="octo-selectable relative flex min-h-0 flex-1 flex-col overflow-hidden bg-octo-onyx">
      <div
        ref={hostRef}
        data-testid="scratchpad-host"
        className="min-h-0 flex-1 overflow-auto"
      />
      {searchOpen && view && (
        <EditorSearch
          view={view}
          scope="tab"
          focusSignal={searchNonce}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}
