import { useEffect, useRef } from "react";
import {
  EditorView,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  drawSelection,
  keymap,
  placeholder,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  defaultKeymap,
  indentWithTab,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { java } from "@codemirror/lang-java";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";
import { atelierTheme } from "./editor/atelierTheme";
import { useScratchpadStore } from "../stores/scratchpadStore";

/**
 * Maps a scratchpad tab's language id to the matching CodeMirror language
 * extension. Languages without a dedicated CodeMirror package fall back to no
 * extension (plain editing, no highlighting) — the editor stays fully usable.
 *
 * Exported for unit testing.
 */
export function langExtension(lang: string): Extension {
  switch (lang) {
    case "javascript":
      return javascript({ jsx: true });
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "python":
      return python();
    case "rust":
      return rust();
    case "java":
      return java();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "html":
      return html();
    case "css":
    case "scss":
    case "sass":
    case "less":
      return css();
    case "xml":
      return xml();
    case "yaml":
      return yaml();
    default:
      return [];
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

export function ScratchpadCodeEditor() {
  const activeTabId = useScratchpadStore((s) => s.activeTabId);
  const tabs = useScratchpadStore((s) => s.tabs);
  const setContent = useScratchpadStore((s) => s.setContent);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeLanguage = activeTab?.language ?? "plaintext";

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!activeTabId || !hostRef.current) return;

    // Read the current content directly from the store at (re)create time so a
    // tab switch loads that tab's saved content. We deliberately do NOT depend
    // on `content` here — that would rebuild the editor on every keystroke and
    // reset the cursor/undo history.
    const initialContent =
      useScratchpadStore.getState().tabs.find((t) => t.id === activeTabId)
        ?.content ?? "";

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
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        langExtension(activeLanguage),
        atelierTheme,
        scratchpadLayout,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setContent(activeTabId, update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Rebuild only when the active tab or its language changes — not on content
    // edits (handled live by the update listener above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeLanguage]);

  if (!activeTab) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-octo-onyx">
        <p className="font-serif text-octo-mute">No tab selected</p>
      </div>
    );
  }

  return (
    <div className="chat-selectable flex min-h-0 flex-1 flex-col overflow-hidden bg-octo-onyx">
      <div
        ref={hostRef}
        data-testid="scratchpad-host"
        className="min-h-0 flex-1 overflow-auto"
      />
    </div>
  );
}
