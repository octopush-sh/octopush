import { useCallback, useEffect, useRef, useState } from "react";
import {
  EditorView, lineNumbers, highlightActiveLineGutter, drawSelection, keymap,
  highlightActiveLine, rectangularSelection, crosshairCursor, getDialog,
} from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, indentUnit } from "@codemirror/language";
import { search, searchKeymap, setSearchQuery, SearchQuery, gotoLine } from "@codemirror/search";
import { buildEditorTheme } from "./editor/atelierTheme";
import { languageSupport } from "../lib/editorLanguages";
import type { LangId } from "../lib/editorLang";
import { EditorSearch } from "./editor/EditorSearch";
import { searchMatchHighlight } from "./editor/searchHighlight";
import { blameGutter } from "./editor/blameGutter";
import { diffGutter, gotoNextChange, gotoPrevChange } from "./editor/diffGutter";
import { EDITOR_NAV_KEYS, EDITOR_PANE_KEYS, GOTO_LINE_DIALOG } from "./editor/navKeys";
import { selectAllOccurrences } from "./editor/multiCursor";
import { symbolOccurrenceHighlight } from "./editor/symbolHighlight";
import { symbolNav, goToDefinitionCommand, type DefinitionRequest } from "./editor/symbolNav";
import {
  findDefinitions,
  DEFINITION_SCORE,
  isReservedWord,
  scoreOptionsFor,
} from "./editor/symbolIndex";
import { classifyClick, classifySite } from "./editor/definitionTree";
import { DefinitionPicker } from "./editor/DefinitionPicker";
import {
  chooseDefinition,
  rankDefinitionHits,
  searchSaturated,
  type DefinitionCandidate,
} from "../lib/definitionSearch";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import { parseDiffForFile } from "../lib/diffParser";
import { useEditorStore, isFileDirty, type NavLocation } from "../stores/editorStore";
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

// ── Live-reconfigurable preference compartments (module-level, stable) ──
const wrapComp = new Compartment();
const lineNumComp = new Compartment();
const tabComp = new Compartment();
const fontComp = new Compartment();
const blameComp = new Compartment();
const themeComp = new Compartment();

interface Prefs { wrap: boolean; fontSize: number; tabWidth: number; lineNumbers: boolean; }

/** How often to re-check whether a held reveal can land, and how long to hold
 *  it before dropping it. See the polling effect for why this isn't an
 *  observer. */
const REVEAL_POLL_MS = 120;
const REVEAL_HOLD_MS = 10_000;

/** Pause after the last keystroke before the text is copied into the store.
 *  Copying it per key cost a full `doc.toString()` and re-rendered the pane,
 *  the tab bar and the Review canvas on every character. */
export const CONTENT_SYNC_MS = 250;

/** Is the editor column actually on screen? False only when something has
 *  deliberately hidden it (reading mode collapses it rather than unmounting).
 *  Environments with no layout engine report "visible" — see the reveal effect. */
function isHostVisible(host: HTMLElement | null): boolean {
  if (!host || typeof host.checkVisibility !== "function") return true;
  return host.checkVisibility({ visibilityProperty: true });
}

const wrapValue = (p: Prefs) => (p.wrap ? EditorView.lineWrapping : []);
const lineNumValue = (p: Prefs) =>
  p.lineNumbers ? [lineNumbers(), foldGutter(), highlightActiveLineGutter()] : [];
const tabValue = (p: Prefs) => [EditorState.tabSize.of(p.tabWidth), indentUnit.of(" ".repeat(p.tabWidth))];
const fontValue = (p: Prefs) =>
  EditorView.theme({ "&": { fontSize: `${p.fontSize}px` }, ".cm-content": { fontSize: `${p.fontSize}px` } });

function buildState(opts: {
  doc: string; lang: string; markers: ReturnType<typeof parseDiffForFile>;
  prefs: Prefs; onSave: () => void; onOpenSearch: () => void;
  onGoToDefinition: (req: DefinitionRequest, view: EditorView) => void;
  onNavigate: (dir: "back" | "forward") => void;
  onGotoLine: () => void;
  onUpdate: (u: {
    docChanged: boolean; selectionSet: boolean;
    /** Asked only while a ⌘⌥G is pending: a state-field read, no DOM. */
    gotoLineOpen: () => boolean;
    line: number; col: number; selections: number;
  }) => void;
}) {
  const {
    doc, lang, markers, prefs, onSave, onOpenSearch, onGoToDefinition,
    onNavigate, onGotoLine, onUpdate,
  } = opts;
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
      // The search extension provides the query state, commands and keymap —
      // but NOT the match highlighting. Its highlighter bails unless its own
      // docked panel is open (`if (!panel …) return Decoration.none`), and the
      // ⌘F binding below deliberately keeps that panel closed. So the marks
      // come from our own plugin instead.
      search({ top: true }),
      searchMatchHighlight,
      // Ambient occurrence highlighting + the ⌘/Ctrl-click gesture. Both are
      // heuristic (no language server): see editor/symbolIndex.ts.
      symbolOccurrenceHighlight,
      symbolNav(onGoToDefinition),
      keymap.of([
        { ...EDITOR_PANE_KEYS.save, run: () => { onSave(); return true; } },
        // Our Octopush-native find overlay owns ⌘F. Listed BEFORE searchKeymap
        // so this binding wins and ⌘F never opens CodeMirror's docked panel — while
        // searchKeymap still provides find-next/prev, go-to-line and
        // select-next-occurrence (⌘G/F3, ⌘⌥G, ⌘D). ⌘G/F3 CAN still open that panel:
        // they're wrapped in `searchCommand`, which opens it when no valid query is
        // set. searchHighlight stands down when it does, so nothing double-paints.
        { ...EDITOR_PANE_KEYS.find, run: () => { onOpenSearch(); return true; } },
        { ...EDITOR_PANE_KEYS.selectAllOccurrences, run: selectAllOccurrences },
        { ...EDITOR_PANE_KEYS.definition, run: goToDefinitionCommand(onGoToDefinition) },
        { ...EDITOR_PANE_KEYS.wrap, run: () => { useEditorPrefs.getState().toggleWrap(); return true; } },
        { ...EDITOR_PANE_KEYS.fontUp, run: () => { useEditorPrefs.getState().bumpFontSize(1); return true; } },
        { ...EDITOR_PANE_KEYS.fontDown, run: () => { useEditorPrefs.getState().bumpFontSize(-1); return true; } },
        { ...EDITOR_NAV_KEYS.back, run: () => { onNavigate("back"); return true; } },
        { ...EDITOR_NAV_KEYS.forward, run: () => { onNavigate("forward"); return true; } },
        { ...EDITOR_NAV_KEYS.nextChange, run: gotoNextChange },
        { ...EDITOR_NAV_KEYS.prevChange, run: gotoPrevChange },
        // Ahead of searchKeymap's own ⌘⌥G so the pane can note where the
        // reader stood: the dialog jumps on submit, long after the key.
        { ...EDITOR_NAV_KEYS.gotoLine, run: (view) => { onGotoLine(); return gotoLine(view); } },
        indentWithTab,
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      languageSupport(lang as LangId),
      themeComp.of(buildEditorTheme()),
      diffGutter(markers),
      EditorView.updateListener.of((update) => {
        const head = update.state.selection.main.head;
        const lineObj = update.state.doc.lineAt(head);
        onUpdate({
          // No text here: serialising the whole document costs the same as the
          // edit that caused it, and this listener runs on EVERY update. The
          // pane copies the text once typing pauses (CONTENT_SYNC_MS).
          docChanged: update.docChanged,
          selectionSet: update.selectionSet,
          gotoLineOpen: () => getDialog(update.view, GOTO_LINE_DIALOG) !== null,
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

  // ── Buffer → store sync ─────────────────────────────────────────
  // The first keystroke only flags the buffer dirty (`markEdited`, one store
  // write); the text itself is copied once typing pauses, or right away when
  // something needs it: a save, a tab switch, unmount.
  const syncRef = useRef<{ workspaceId: string; path: string; timer: number } | null>(null);
  const flushContent = useCallback(() => {
    const pending = syncRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    syncRef.current = null;
    const view = viewRef.current;
    // Only while the view still holds that file's document.
    if (view && lastPathRef.current === pending.path) {
      useEditorStore
        .getState()
        .setContent(pending.workspaceId, pending.path, view.state.doc.toString());
    }
  }, []);
  const dropPendingSync = useCallback(() => {
    if (syncRef.current) window.clearTimeout(syncRef.current.timer);
    syncRef.current = null;
  }, []);
  const scheduleSync = useCallback(
    (ws: string, path: string) => {
      if (syncRef.current && syncRef.current.path !== path) flushContent();
      if (!syncRef.current) useEditorStore.getState().markEdited(ws, path);
      else window.clearTimeout(syncRef.current.timer);
      syncRef.current = {
        workspaceId: ws,
        path,
        timer: window.setTimeout(flushContent, CONTENT_SYNC_MS),
      };
    },
    [flushContent],
  );

  // ── Back/forward trail ──────────────────────────────────────────
  // The store asks this where the reader is whenever a jump starts or Back
  // runs. Null while no text file is showing (nothing to come back to).
  const currentLocation = useCallback((): NavLocation | null => {
    const view = viewRef.current;
    const path = lastPathRef.current;
    if (!view || !path) return null;
    const { anchor, head } = view.state.selection.main;
    // The host div scrolls, not `.cm-scroller`: the editor grows to its
    // content, so CodeMirror's own scroll snapshot would always read 0.
    return { path, anchor, head, scrollTop: hostRef.current?.scrollTop ?? 0 };
  }, []);
  useEffect(() => {
    const { setLocationProvider } = useEditorStore.getState();
    setLocationProvider(workspaceId, currentLocation);
    return () => setLocationProvider(workspaceId, null);
  }, [workspaceId, currentLocation]);
  const recordLocation = useCallback(
    (from?: NavLocation) => useEditorStore.getState().recordLocation(workspaceId, from),
    [workspaceId],
  );
  // Where ⌘⌥G was pressed, held until its dialog jumps (recorded) or closes.
  const gotoLineOriginRef = useRef<NavLocation | null>(null);

  const [pos, setPos] = useState({ line: 1, col: 1, selections: 1 });

  // Re-runs the reveal effect while a reveal is being held for a hidden column.
  //
  // A ResizeObserver is not enough: `ModeOverlay` hides the whole Review canvas
  // with `visibility: hidden` at UNCHANGED width, so nothing resizes and the
  // held reveal would never be released — it would instead ambush the reader
  // later, when the active path next cycled. Polling covers every way the
  // column can come back, and it only runs while something is actually held.
  const [hostVisibleTick, setHostVisibleTick] = useState(0);
  useEffect(() => {
    if (!pendingReveal) return;
    // Only a HIDDEN column is worth polling for. A reveal that the effect above
    // declined for any other reason (the active file is binary, or isn't the
    // revealed one) would otherwise tick — and re-render the pane — every
    // 120 ms forever, since the drop below can only fire while hidden.
    if (isHostVisible(hostRef.current)) return;
    const started = Date.now();
    const id = window.setInterval(() => {
      if (isHostVisible(hostRef.current)) {
        setHostVisibleTick((n) => n + 1);
      } else if (Date.now() - started > REVEAL_HOLD_MS) {
        // Drop it rather than let it fire minutes later into a context the
        // reader has long left — the same rule the Markdown jump follows.
        clearPendingReveal(workspaceId);
      }
    }, REVEAL_POLL_MS);
    return () => window.clearInterval(id);
  }, [pendingReveal, hostVisibleTick, workspaceId, clearPendingReveal]);

  // Find/replace overlay. searchNonce is bumped on every ⌘F so an already-open
  // overlay refocuses and selects its query instead of silently no-op'ing.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchNonce, setSearchNonce] = useState(0);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchNonce((n) => n + 1);
  }, []);

  // ── Go to definition ────────────────────────────────────────────
  // Ambiguous cross-file results, and the "still looking" note for the
  // workspace scan (a literal search over every text file is fast, but not
  // instant, and a ⌘-click that shows nothing reads as a dead click).
  const [definitionPicker, setDefinitionPicker] =
    useState<{
      symbol: string;
      candidates: DefinitionCandidate[];
      /** Where the request came from: the stop a pick leaves behind. */
      origin: NavLocation | null;
    } | null>(null);
  const [definitionSearching, setDefinitionSearching] = useState<string | null>(null);
  /** Bumped per request so a superseded workspace scan lands nowhere. */
  const definitionGenerationRef = useRef(0);

  const openAsJump = useEditorStore((s) => s.openAsJump);

  const toRelative = useCallback(
    (path: string) =>
      path.startsWith(workspacePath + "/") ? path.slice(workspacePath.length + 1) : path,
    [workspacePath],
  );

  const openAtLine = useCallback(
    async (relativePath: string, line: number, from: NavLocation | null) => {
      const absolute = relativePath.startsWith("/")
        ? relativePath
        : `${workspacePath}/${relativePath}`;
      let opened: boolean;
      try {
        opened = await openAsJump(workspaceId, absolute, { line, from });
      } catch (e) {
        pushToast({ level: "error", title: "Could not open file", body: String(e) });
        return;
      }
      // `openFile` declines an oversized file when no confirm handler is passed,
      // and it declines silently. EditorPane has no dialog of its own to offer
      // (the large-file confirm lives in App, above the Review canvas), so say
      // what happened rather than letting the jump look like a dead click.
      if (!opened) {
        pushToast({
          level: "info",
          title: "File too large to open here",
          body: `${relativePath}:${line} — open it from the file tree to confirm.`,
        });
      }
    },
    [openAsJump, workspaceId, workspacePath],
  );

  /**
   * Resolve `req` to a declaration, nearest scope first: the open document,
   * then the workspace. The in-file answer is synchronous and exact enough to
   * feel instant; the workspace answer goes through the ranking in
   * `lib/definitionSearch.ts`, which either jumps or asks.
   */
  const goToDefinition = useCallback(
    async (req: DefinitionRequest, view: EditorView) => {
      // Bumped FIRST, before any branch returns: an in-file jump (or a refusal)
      // also supersedes a workspace scan still in flight, which would otherwise
      // land later and drag the reader out of the file they just jumped to.
      const generation = ++definitionGenerationRef.current;
      const current = () => generation === definitionGenerationRef.current;
      // Retire the previous request's chip here rather than in its own
      // `finally`: a superseded scan's `finally` is guarded by `current()` and
      // so declines to touch the state, which left the chip on screen forever
      // whenever the newer request answered without searching.
      setDefinitionSearching(null);
      // The stop is the occurrence asked about, taken before any await. A
      // ⌘-click doesn't move the caret (symbolNav swallows the mousedown), so
      // the selection may still be on a line scrolled far out of view.
      const here = currentLocation();
      const origin = here && { ...here, anchor: req.from, head: req.from };

      const lang = activeFile?.lang;
      const doc = view.state.doc.toString();
      // The tree vetoes line-heuristic candidates it knows are not
      // declarations (a JavaScript `run = 5` re-assigns, it doesn't declare).
      const sites = findDefinitions(doc, req.name, scoreOptionsFor(lang))
        .map((site) => ({ ...site, verdict: classifySite(view.state, lang, site) }))
        .filter((site) => site.verdict !== "other");
      // Skip the occurrence that was clicked: standing on a use of `foo` must
      // not "jump" to that same use and look like nothing happened.
      const elsewhere = sites.filter((d) => d.from !== req.from);
      // Go's `x := …` declares by definition, and Go has no tree to say so.
      const shortVarDecl = (site: { to: number }) =>
        lang === "go" && /^\s*:=/.test(doc.slice(site.to, site.to + 16));
      // A lone candidate that is only a bare `foo = …` binding (and that no
      // tree confirmed) is not worth a jump without asking: the real
      // declaration may well be in another file, so let the workspace rank it.
      const lone = elsewhere.length === 1 ? elsewhere[0] : null;
      const loneIsWeak =
        !!lone &&
        lone.verdict !== "declaration" &&
        !shortVarDecl(lone) &&
        lone.score < DEFINITION_SCORE.signature;
      if (elsewhere.length > 0 && !loneIsWeak) {
        const site = elsewhere[0];
        if (origin) recordLocation(origin);
        view.dispatch({
          selection: { anchor: site.from, head: site.to },
          effects: EditorView.scrollIntoView(site.from, { y: "center" }),
        });
        view.focus();
        return;
      }

      // The clicked occurrence IS the declaration and there is no other in this
      // file. Escalating to a workspace search here would drop the reader into
      // an unrelated same-named declaration somewhere else — or, worse, report
      // that nothing declares `parse` while they sit on `function parse`. Only
      // the two confident tiers (and Go's `:=`) short-circuit; a bare `foo = …`
      // binding is weak enough that the real declaration may well be in
      // another file.
      const clicked = sites.find((d) => d.from === req.from);
      if (clicked && (clicked.score >= DEFINITION_SCORE.signature || shortVarDecl(clicked))) {
        pushToast({
          level: "info",
          title: "Already at the definition",
          body: `${req.name} is declared here.`,
        });
        return;
      }

      // A keyword or a type keyword is part of the language: nothing in the
      // workspace declares `static` or `int`, and a literal hunt for the word
      // only finds the lines that use it. Checked only once the open file had
      // its say, and per language: `val` and `self` are keywords in Kotlin and
      // Rust but ordinary names in Go and C. The syntax tree answers where
      // the language has one; elsewhere, the active language's reserved words.
      const click = classifyClick(view.state, lang, req);
      if (click === "keyword" || (click === "unknown" && isReservedWord(lang, req.name))) {
        pushToast({
          level: "info",
          title: "No definition found in this workspace",
          body: `${req.name} is part of the language.`,
        });
        return;
      }

      const fromFile = activePath ? toRelative(activePath) : undefined;
      const fromLine = view.state.doc.lineAt(req.from).number;

      setDefinitionSearching(req.name);
      try {
        // Whole-word: a symbol lookup for `run` must not spend the backend's
        // 500-hit cap on `running` and `rerun` before reaching `fn run`.
        const hits = await ipc.searchWorkspaceText(workspacePath, req.name, true, true);
        if (!current()) return;
        const choice = chooseDefinition(
          rankDefinitionHits(hits, req.name, { fromFile, fromLine }),
        );
        if (choice.kind === "jump") {
          await openAtLine(choice.candidate.file, choice.candidate.line, origin);
        } else if (choice.kind === "choose") {
          setDefinitionPicker({ symbol: req.name, candidates: choice.candidates, origin });
        } else if (searchSaturated(hits)) {
          // The scan stops at its own ceiling, and even whole-word a genuinely
          // common symbol (`id`, `value`) can fill it with real uses before
          // reaching the declaration. Saying "nothing declares it" here would be
          // a claim the search never actually made.
          pushToast({
            level: "info",
            title: "Too many matches to narrow",
            body: `${req.name} appears too often for the search to find its declaration. Try ⌘⇧F.`,
          });
        } else {
          // Also the answer for a built-in such as `String` or `Integer`: the
          // lines that mention it only ever use it as a type.
          pushToast({
            level: "info",
            title: "No definition found in this workspace",
            body: `Nothing here declares ${req.name}. It may come from the language or a library.`,
          });
        }
      } catch (e) {
        if (current()) {
          pushToast({ level: "error", title: "Definition search failed", body: String(e) });
        }
      } finally {
        if (current()) setDefinitionSearching(null);
      }
    },
    [activePath, activeFile?.lang, currentLocation, openAtLine, recordLocation, toRelative, workspacePath],
  );

  // Cached editor states hold whatever handler they were built with, so the
  // one handed to CodeMirror has to be stable and read the latest through a
  // ref — otherwise a tab restored from cache would call a stale closure.
  const goToDefinitionRef = useRef(goToDefinition);
  goToDefinitionRef.current = goToDefinition;
  const requestDefinition = useCallback(
    (req: DefinitionRequest, view: EditorView) => {
      void goToDefinitionRef.current(req, view);
    },
    [],
  );

  const freshState = (file: { path: string; content: string; lang: string }) => {
    const relPath = file.path.startsWith(workspacePath + "/")
      ? file.path.slice(workspacePath.length + 1) : file.path;
    const markers = parseDiffForFile(diffText, relPath);
    return buildState({
      doc: file.content, lang: file.lang, markers, prefs: prefsRef.current,
      onSave: () => { flushContent(); saveActive(workspaceId).catch(console.error); },
      onOpenSearch: openSearch,
      onGoToDefinition: requestDefinition,
      onNavigate: (dir) => {
        const store = useEditorStore.getState();
        void (dir === "back" ? store.navigateBack(workspaceId) : store.navigateForward(workspaceId));
      },
      onGotoLine: () => { gotoLineOriginRef.current = currentLocation(); },
      onUpdate: (u) => {
        if (u.docChanged) scheduleSync(workspaceId, file.path);
        // ⌘⌥G's jump is the first selection change once its dialog has
        // closed. A click in the text while the dialog stays open isn't it.
        const origin = gotoLineOriginRef.current;
        if (origin && !u.gotoLineOpen()) {
          if (u.selectionSet && !u.docChanged) {
            gotoLineOriginRef.current = null;
            recordLocation(origin);
          } else {
            // A close alone isn't a cancel yet: the dialog queues its own close
            // one microtask AHEAD of the submit handler that jumps. Escape and
            // bad input never jump, so the origin goes after this task.
            window.setTimeout(() => {
              if (gotoLineOriginRef.current === origin) gotoLineOriginRef.current = null;
            }, 0);
          }
        }
        // Same values → same object, so React bails out instead of re-rendering
        // the pane for every transaction that left the caret where it was.
        setPos((prev) =>
          prev.line === u.line && prev.col === u.col && prev.selections === u.selections
            ? prev
            : { line: u.line, col: u.col, selections: u.selections },
        );
      },
    });
  };

  // Create the view once; destroy on unmount.
  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const view = new EditorView({ parent: hostRef.current });
    viewRef.current = view;
    return () => { flushContent(); view.destroy(); viewRef.current = null; stateCache.current.clear(); lastPathRef.current = null; };
  }, []);

  // Swap the document state when the active file changes; preserve per-tab state.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Cache the outgoing text tab's live state before any switch. Strip any
    // active find query first so its match highlights don't linger in the
    // cached snapshot and reappear (with no overlay to drive them) on return.
    const prevPath = lastPathRef.current;
    if (prevPath && prevPath !== activeFile?.path) {
      // The view still holds the outgoing document: sync its text now.
      flushContent();
      view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
      stateCache.current.set(prevPath, view.state);
    }
    // A ⌘⌥G left open on the outgoing tab never jumps from this one.
    gotoLineOriginRef.current = null;

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
      // Restored cached states carry the theme they were built with; re-apply
      // the current one so a theme switch while another tab was active lands.
      themeComp.reconfigure(buildEditorTheme()),
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
    // In Markdown "reading" mode `EditorWithPreview` collapses this column to
    // `width: 0; visibility: hidden` rather than unmounting it. Scrolling a
    // zero-width viewport does nothing, and consuming the reveal here would
    // throw the request away — so hold it instead. `hostVisibleTick` re-runs
    // this effect the moment the column is laid out again.
    //
    // `checkVisibility` rather than a zero-width test on purpose: a width of 0
    // is also what any environment without layout reports (jsdom included), and
    // holding every reveal there would be far worse than the bug. Where the API
    // is missing, treat the column as visible.
    if (!isHostVisible(hostRef.current)) return;

    const doc = view.state.doc;
    const { restore } = pendingReveal;
    if (restore) {
      // Back/forward: the exact selection and scroll the reader left. The
      // file may have shrunk since; clamp, and only put the old scroll back
      // while the document still reaches the old selection.
      const clamp = (n: number) => Math.max(0, Math.min(n, doc.length));
      const anchor = clamp(restore.anchor);
      const head = clamp(restore.head);
      const { scrollTop } = restore;
      if (scrollTop != null && doc.length >= Math.max(restore.anchor, restore.head)) {
        view.dispatch({ selection: { anchor, head } });
        // After CodeMirror's own measure, once the restored document has its
        // height — set any earlier and the browser clamps the offset.
        view.requestMeasure({
          read: () => null,
          write: () => { if (hostRef.current) hostRef.current.scrollTop = scrollTop; },
        });
      } else {
        view.dispatch({
          selection: { anchor, head },
          effects: EditorView.scrollIntoView(head, { y: "center" }),
        });
      }
    } else {
      const lineNo = Math.max(1, Math.min(pendingReveal.line, doc.lines));
      const target = doc.line(lineNo);
      // A column past the end of the line lands on its end.
      const pos =
        pendingReveal.col == null
          ? target.from
          : target.from + Math.max(0, Math.min(pendingReveal.col - 1, target.length));
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    }
    view.focus?.();
    clearPendingReveal(workspaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal, activePath, workspaceId, hostVisibleTick]);

  // Replace the document when the active buffer was reloaded from disk
  // (version bump): the swap effect only fires on path changes, so an
  // external reload of the *current* tab needs its own refresh.
  const activeVersion = activeFile?.kind === "text" ? activeFile.version : 0;
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !activeFile || activeFile.kind !== "text") return;
    if (activeFile.version === 0) return; // never reloaded
    if (view.state.doc.toString() === activeFile.content) return;
    // The disk version replaces the buffer; unsynced keys go with it.
    dropPendingSync();
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

  // Follow Octopush theme switches: themeStore.applyThemeToDom fires `octo:theme`
  // after writing the new tokens to :root; rebuild the editor theme from the
  // live tokens and reconfigure the compartment so the editor repaints with the
  // rest of the app (CodeMirror's theme() can't read CSS variables directly).
  useEffect(() => {
    const onTheme = () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ effects: themeComp.reconfigure(buildEditorTheme()) });
    };
    window.addEventListener("octo:theme", onTheme);
    return () => window.removeEventListener("octo:theme", onTheme);
  }, []);

  // Close the find overlay when the active file changes — its query/highlights
  // belong to the previous document's state, which the swap just replaced.
  useEffect(() => {
    setSearchOpen(false);
  }, [activePath]);

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
    <div data-tour="review-editor" className="octo-selectable flex min-h-0 flex-1 flex-col overflow-hidden">
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
        {searchOpen && activeFile?.kind === "text" && viewRef.current && (
          <EditorSearch
            view={viewRef.current}
            focusSignal={searchNonce}
            onClose={() => setSearchOpen(false)}
          />
        )}
        {definitionSearching && (
          <div
            className="octo-fade-in pointer-events-none absolute bottom-3 right-3 rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-brass"
            style={{
              background: "var(--color-octo-panel)",
              border: "1px solid var(--brass-dim)",
            }}
          >
            Looking for {definitionSearching}…
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
          blameSavedNote={blameEnabled && isFileDirty(activeFile)}
        />
      )}
      {definitionPicker && (
        <DefinitionPicker
          symbol={definitionPicker.symbol}
          candidates={definitionPicker.candidates}
          onPick={(c) => {
            setDefinitionPicker(null);
            void openAtLine(c.file, c.line, definitionPicker.origin);
          }}
          onClose={() => setDefinitionPicker(null)}
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
            flushContent();
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
