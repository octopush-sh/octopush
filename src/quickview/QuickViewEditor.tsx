import { useCallback, useEffect, useRef, useState } from "react";
import {
  EditorView,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  drawSelection,
  keymap,
} from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { indentOnInput, bracketMatching, foldGutter, indentUnit } from "@codemirror/language";
import { buildEditorTheme } from "../components/editor/atelierTheme";
import { EditorSearch } from "../components/editor/EditorSearch";
import { searchMatchHighlight } from "../components/editor/searchHighlight";
import { symbolOccurrenceHighlight } from "../components/editor/symbolHighlight";
import { languageSupport } from "../lib/editorLanguages";
import type { LangId } from "../lib/editorLang";
import { useEditorPrefs } from "../stores/editorPrefsStore";

const themeComp = new Compartment();

const layout = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

interface Props {
  /** Initial document. Later changes to this prop are ignored — push a new
   *  document through the view handed to `onReady` instead, so undo history
   *  and the caret survive re-renders. */
  doc: string;
  lang: LangId;
  onChange: (doc: string) => void;
  onSave: () => void;
  onReady: (view: EditorView | null) => void;
}

/** CodeMirror for Quick View: the Review editor's theme, language support,
 *  find overlay and preferences (wrap, font size, tab width, line numbers),
 *  without the workspace-bound extras (blame, diff gutter, go-to-definition). */
export function QuickViewEditor({ doc, lang, onChange, onSave, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchNonce, setSearchNonce] = useState(0);

  // Handlers change identity on every parent render; the editor is built once.
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const prefs = useEditorPrefs.getState();
    const state = EditorState.create({
      doc,
      extensions: [
        prefs.lineNumbers ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : [],
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        EditorState.tabSize.of(prefs.tabWidth),
        indentUnit.of(" ".repeat(prefs.tabWidth)),
        prefs.wrap ? EditorView.lineWrapping : [],
        EditorView.theme({
          "&": { fontSize: `${prefs.fontSize}px` },
          ".cm-content": { fontSize: `${prefs.fontSize}px` },
        }),
        search({ top: true }),
        searchMatchHighlight,
        symbolOccurrenceHighlight,
        keymap.of([
          { key: "Mod-s", run: () => { handlers.current.onSave(); return true; } },
          // Before searchKeymap so ⌘F opens the Atelier overlay, not the
          // docked panel (same arrangement as the Review editor).
          { key: "Mod-f", run: () => { openSearch(); return true; } },
          indentWithTab,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        languageSupport(lang),
        themeComp.of(buildEditorTheme()),
        layout,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
        }),
      ],
    });
    const created = new EditorView({ state, parent: hostRef.current });
    viewRef.current = created;
    setView(created);
    onReady(created);
    return () => {
      created.destroy();
      viewRef.current = null;
      setView(null);
      onReady(null);
    };
    // Built once per file/language; edits flow out through the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  useEffect(() => {
    const onTheme = () =>
      viewRef.current?.dispatch({ effects: themeComp.reconfigure(buildEditorTheme()) });
    window.addEventListener("octo:theme", onTheme);
    return () => window.removeEventListener("octo:theme", onTheme);
  }, []);

  return (
    <div className="octo-selectable relative flex min-h-0 flex-1 flex-col overflow-hidden bg-octo-onyx">
      <div ref={hostRef} data-testid="quickview-editor" className="min-h-0 flex-1 overflow-auto" />
      {searchOpen && view && (
        <EditorSearch
          view={view}
          scope="file"
          focusSignal={searchNonce}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}

/** Replace the whole document as one undoable change. */
export function replaceDoc(view: EditorView, text: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}
