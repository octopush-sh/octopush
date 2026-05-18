import { useEffect, useRef } from "react";
import { EditorView, lineNumbers, highlightActiveLineGutter, drawSelection, keymap, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
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
import { atelierTheme } from "./editor/atelierTheme";
import { diffGutter } from "./editor/diffGutter";
import { parseDiffForFile } from "../lib/diffParser";
import { useEditorStore } from "../stores/editorStore";

interface Props {
  workspaceId: string;
  workspacePath: string;
  diffText: string;
}

/** Returns the CodeMirror language extension for a given lang id. */
function langExtension(lang: string) {
  switch (lang) {
    case "javascript": return javascript({ typescript: true, jsx: true });
    case "rust":       return rust();
    case "python":     return python();
    case "java":       return java();
    case "json":       return json();
    case "markdown":   return markdown();
    case "html":       return html();
    case "css":        return css();
    case "xml":        return xml();
    case "yaml":       return yaml();
    default:           return [];
  }
}

export function EditorPane({ workspaceId, workspacePath, diffText }: Props) {
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const setContent = useEditorStore((s) => s.setContent);
  const saveActive = useEditorStore((s) => s.saveActive);

  const activeFile = activePath
    ? files.find((f) => f.path === activePath) ?? null
    : null;

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!activeFile || !hostRef.current) return;

    // Compute diff markers for this file.
    const relPath = activeFile.path.startsWith(workspacePath + "/")
      ? activeFile.path.slice(workspacePath.length + 1)
      : activeFile.path;
    const markers = parseDiffForFile(diffText, relPath);

    const state = EditorState.create({
      doc: activeFile.content,
      extensions: [
        // Base extensions
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        // Keymaps
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              saveActive(workspaceId).catch(console.error);
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Language
        langExtension(activeFile.lang),
        // Theme
        atelierTheme,
        // Diff gutter
        diffGutter(markers),
        // Change listener — sync content to store
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setContent(workspaceId, activeFile.path, update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: hostRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-create the editor only when the active file PATH changes (not on every
    // content change — that would reset the cursor and undo history).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, workspaceId]);

  if (!activeFile) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <span className="font-serif italic text-[15px] text-octo-mute">
          Select a file from the tree to begin.
        </span>
      </div>
    );
  }

  return (
    <div className="chat-selectable flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={hostRef}
        data-testid="editor-host"
        className="min-h-0 flex-1 overflow-auto"
        style={{ background: "var(--color-octo-onyx)" }}
      />
    </div>
  );
}
