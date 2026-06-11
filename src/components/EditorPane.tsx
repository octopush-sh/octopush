import { useEffect, useRef, useState } from "react";
import {
  EditorView, lineNumbers, highlightActiveLineGutter, drawSelection, keymap,
  highlightActiveLine, rectangularSelection, crosshairCursor,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, indentUnit } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
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
import { blameGutter } from "./editor/blameGutter";
import { diffGutter } from "./editor/diffGutter";
import { selectAllOccurrences } from "./editor/multiCursor";
import { parseDiffForFile } from "../lib/diffParser";
import { useEditorStore } from "../stores/editorStore";
import { useEditorPrefs } from "../stores/editorPrefsStore";
import { useBlameStore } from "../stores/blameStore";
import { EditorStatusBar } from "./EditorStatusBar";
import { EditorBinaryPane } from "./EditorBinaryPane";
import { ConfirmDialog } from "./ConfirmDialog";

interface Props {
  workspaceId: string;
  workspacePath: string;
  diffText: string;
}

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

// ── Live-reconfigurable preference compartments (module-level, stable) ──
const wrapComp = new Compartment();
const lineNumComp = new Compartment();
const tabComp = new Compartment();
const fontComp = new Compartment();
const blameComp = new Compartment();

interface Prefs { wrap: boolean; fontSize: number; tabWidth: number; lineNumbers: boolean; }

const wrapValue = (p: Prefs) => (p.wrap ? EditorView.lineWrapping : []);
const lineNumValue = (p: Prefs) =>
  p.lineNumbers ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : [];
const tabValue = (p: Prefs) => [EditorState.tabSize.of(p.tabWidth), indentUnit.of(" ".repeat(p.tabWidth))];
const fontValue = (p: Prefs) =>
  EditorView.theme({ "&": { fontSize: `${p.fontSize}px` }, ".cm-content": { fontSize: `${p.fontSize}px` } });

function buildState(opts: {
  doc: string; lang: string; markers: ReturnType<typeof parseDiffForFile>;
  prefs: Prefs; onSave: () => void;
  onUpdate: (u: { docChanged: boolean; doc: string; line: number; col: number; selections: number }) => void;
}) {
  const { doc, lang, markers, prefs, onSave, onUpdate } = opts;
  return EditorState.create({
    doc,
    extensions: [
      blameComp.of([]),
      lineNumComp.of(lineNumValue(prefs)),
      highlightActiveLine(),
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      indentOnInput(),
      bracketMatching(),
      tabComp.of(tabValue(prefs)),
      wrapComp.of(wrapValue(prefs)),
      fontComp.of(fontValue(prefs)),
      search({ top: true }),
      keymap.of([
        { key: "Mod-s", run: () => { onSave(); return true; } },
        { key: "Mod-Shift-l", run: selectAllOccurrences },
        { key: "Alt-z", run: () => { useEditorPrefs.getState().toggleWrap(); return true; } },
        { key: "Mod-=", run: () => { useEditorPrefs.getState().bumpFontSize(1); return true; } },
        { key: "Mod--", run: () => { useEditorPrefs.getState().bumpFontSize(-1); return true; } },
        indentWithTab,
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      langExtension(lang),
      atelierTheme,
      diffGutter(markers),
      EditorView.updateListener.of((update) => {
        const head = update.state.selection.main.head;
        const lineObj = update.state.doc.lineAt(head);
        onUpdate({
          docChanged: update.docChanged,
          doc: update.state.doc.toString(),
          line: lineObj.number,
          col: head - lineObj.from + 1,
          selections: update.state.selection.ranges.length,
        });
      }),
    ],
  });
}

export function EditorPane({ workspaceId, workspacePath, diffText }: Props) {
  const activePath = useEditorStore((s) => s.getActivePath(workspaceId));
  const files = useEditorStore((s) => s.getFiles(workspaceId));
  const setContent = useEditorStore((s) => s.setContent);
  const saveActive = useEditorStore((s) => s.saveActive);
  const closeFile = useEditorStore((s) => s.closeFile);
  const reloadFromDisk = useEditorStore((s) => s.reloadFromDisk);
  const checkActiveAgainstDisk = useEditorStore((s) => s.checkActiveAgainstDisk);
  const saveConflict = useEditorStore((s) => s.saveConflict);
  const clearSaveConflict = useEditorStore((s) => s.clearSaveConflict);
  const pendingReveal = useEditorStore((s) => s.getPendingReveal(workspaceId));
  const clearPendingReveal = useEditorStore((s) => s.clearPendingReveal);

  const wrap = useEditorPrefs((s) => s.wrap);
  const fontSize = useEditorPrefs((s) => s.fontSize);
  const tabWidth = useEditorPrefs((s) => s.tabWidth);
  const lineNumbersPref = useEditorPrefs((s) => s.lineNumbers);
  const prefs: Prefs = { wrap, fontSize, tabWidth, lineNumbers: lineNumbersPref };

  const blameEnabled = useBlameStore((s) => s.enabled);
  const blameLines = useBlameStore((s) =>
    activePath ? s.linesByPath[activePath] : undefined,
  );

  const activeFile = activePath ? files.find((f) => f.path === activePath) ?? null : null;

  // A blocked save for this workspace — resolved by the dialog below.
  const conflict =
    saveConflict && saveConflict.workspaceId === workspaceId ? saveConflict : null;
  const conflictName = conflict
    ? conflict.path.split("/").pop() ?? conflict.path
    : "";

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const stateCache = useRef<Map<string, EditorState>>(new Map());
  const lastPathRef = useRef<string | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [pos, setPos] = useState({ line: 1, col: 1, selections: 1 });

  const freshState = (file: { path: string; content: string; lang: string }) => {
    const relPath = file.path.startsWith(workspacePath + "/")
      ? file.path.slice(workspacePath.length + 1) : file.path;
    const markers = parseDiffForFile(diffText, relPath);
    return buildState({
      doc: file.content, lang: file.lang, markers, prefs: prefsRef.current,
      onSave: () => saveActive(workspaceId).catch(console.error),
      onUpdate: (u) => {
        if (u.docChanged) setContent(workspaceId, file.path, u.doc);
        setPos({ line: u.line, col: u.col, selections: u.selections });
      },
    });
  };

  // Create the view once; destroy on unmount.
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const view = new EditorView({ parent: hostRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; stateCache.current.clear(); lastPathRef.current = null; };
  }, []);

  // Swap the document state when the active file changes; preserve per-tab state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Cache the outgoing text tab's live state before any switch.
    const prevPath = lastPathRef.current;
    if (prevPath && prevPath !== activeFile?.path) {
      stateCache.current.set(prevPath, view.state);
    }

    // No active file, or a binary file: clear the view so neither stale text
    // nor garbled bytes show behind the overlay / binary pane.
    if (!activeFile || activeFile.kind !== "text") {
      view.setState(EditorState.create({ doc: "" }));
      lastPathRef.current = null;
      return;
    }

    const cached = stateCache.current.get(activeFile.path);
    view.setState(cached ?? freshState(activeFile));
    view.dispatch({ effects: [
      wrapComp.reconfigure(wrapValue(prefsRef.current)),
      lineNumComp.reconfigure(lineNumValue(prefsRef.current)),
      tabComp.reconfigure(tabValue(prefsRef.current)),
      fontComp.reconfigure(fontValue(prefsRef.current)),
    ]});
    lastPathRef.current = activeFile.path;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, workspaceId]);

  // One-shot open-at-line: once the revealed file IS the active document
  // (declared after the swap effect so the doc is already in place), put the
  // cursor on the requested line and scroll it to the center. Consuming the
  // reveal keeps later tab switches from re-jumping.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pendingReveal) return;
    if (!activeFile || activeFile.kind !== "text") return;
    if (activeFile.path !== pendingReveal.path) return;

    const doc = view.state.doc;
    const lineNo = Math.max(1, Math.min(pendingReveal.line, doc.lines));
    const pos = doc.line(lineNo).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus?.();
    clearPendingReveal(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal, activePath, workspaceId]);

  // Replace the document when the active buffer was reloaded from disk
  // (version bump): the swap effect only fires on path changes, so an
  // external reload of the *current* tab needs its own refresh.
  const activeVersion = activeFile?.kind === "text" ? activeFile.version : 0;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activeFile || activeFile.kind !== "text") return;
    if (activeFile.version === 0) return; // never reloaded
    if (view.state.doc.toString() === activeFile.content) return;
    stateCache.current.delete(activeFile.path); // drop the stale doc
    view.setState(freshState(activeFile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVersion, activePath]);

  // External-change watch: when the window regains focus (or the tab becomes
  // visible again), compare the active buffer against the disk. Agents and
  // tree file ops write underneath open buffers — this catches it early.
  useEffect(() => {
    const check = () => { checkActiveAgainstDisk(workspaceId).catch(() => {}); };
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspaceId, checkActiveAgainstDisk]);

  // Evict cache entries for files that are no longer open.
  useEffect(() => {
    const open = new Set(files.map((f) => f.path));
    for (const p of stateCache.current.keys()) if (!open.has(p)) stateCache.current.delete(p);
  }, [files]);

  // Reconfigure compartments live when prefs change.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: [
      wrapComp.reconfigure(wrapValue(prefs)),
      lineNumComp.reconfigure(lineNumValue(prefs)),
      tabComp.reconfigure(tabValue(prefs)),
      fontComp.reconfigure(fontValue(prefs)),
    ]});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrap, fontSize, tabWidth, lineNumbersPref]);

  // ── Blame gutter (G7 slice III) ─────────────────────────────────
  // Fetch blame for the active file while the toggle is on. Re-fetches on
  // file switch, save (mtime bump) and external reload (version bump) so the
  // gutter never describes a state the disk no longer has.
  const activeMtime = activeFile?.kind === "text" ? activeFile.mtime : 0;
  useEffect(() => {
    if (!blameEnabled || !activeFile || activeFile.kind !== "text") return;
    void useBlameStore.getState().load(workspacePath, activeFile.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blameEnabled, activePath, activeVersion, activeMtime, workspacePath]);

  // Swap the gutter in/out via its compartment. Runs after the file-swap
  // effect (declared later), so restored cached states get re-decorated too.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: blameComp.reconfigure(
        blameEnabled && blameLines ? blameGutter(blameLines) : [],
      ),
    });
  }, [blameEnabled, blameLines, activePath]);

  // IMPORTANT: the host is mounted UNCONDITIONALLY so the view-once effect (deps
  // `[]`) always finds `hostRef.current`. The empty-state message is an overlay,
  // not an early return — an early return would unmount the host on the
  // null→active transition and the `[]` effect would never create the view.
  return (
    <div className="chat-selectable flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          data-testid="editor-host"
          className="absolute inset-0 overflow-auto"
          style={{ background: "var(--color-octo-onyx)" }}
        />
        {!activeFile && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="font-serif text-[15px] text-octo-mute">
              Select a file from the tree to begin.
            </span>
          </div>
        )}
        {activeFile?.kind === "binary" && (
          <div className="absolute inset-0" style={{ background: "var(--color-octo-onyx)" }}>
            <EditorBinaryPane
              path={activeFile.path}
              size={activeFile.size}
              reason={activeFile.binaryReason ?? "binary"}
            />
          </div>
        )}
      </div>
      {activeFile?.kind === "text" && (
        <EditorStatusBar
          line={pos.line}
          col={pos.col}
          selectionCount={pos.selections}
          lang={activeFile.lang}
          diskStale={activeFile.diskStale}
          blameSavedNote={blameEnabled && activeFile.content !== activeFile.savedContent}
        />
      )}
      {conflict && (
        <ConfirmDialog
          title={
            conflict.kind === "changed"
              ? "File changed on disk"
              : "File deleted on disk"
          }
          body={
            conflict.kind === "changed"
              ? `${conflictName} was modified outside the editor. Overwrite with your version, reload from disk and lose your unsaved edits, or keep editing.`
              : `${conflictName} was deleted on disk. Save your version anyway, close the tab, or keep editing.`
          }
          destructiveLabel={conflict.kind === "changed" ? "Overwrite" : "Save anyway"}
          secondaryLabel={conflict.kind === "changed" ? "Reload from disk" : "Close tab"}
          cancelLabel="Keep editing"
          onConfirm={() => {
            clearSaveConflict();
            saveActive(workspaceId, { force: true }).catch(console.error);
          }}
          onSecondary={() => {
            const { kind, path } = conflict;
            clearSaveConflict();
            if (kind === "changed") {
              reloadFromDisk(workspaceId, path).catch(console.error);
            } else {
              closeFile(workspaceId, path);
            }
          }}
          // Escape lands here — must be the safe choice: dismiss only, lose
          // nothing. The diskStale chip remains the persistent signal.
          onCancel={clearSaveConflict}
        />
      )}
    </div>
  );
}
