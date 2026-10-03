import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Braces, Code2, Eye, FolderOpen, Save } from "lucide-react";
import { ipc, type WorkspaceMatch } from "../lib/ipc";
import { langForExtension, type LangId } from "../lib/editorLang";
import { isMac, modKeyLabel } from "../lib/platform";
import { useThemeStore } from "../stores/themeStore";
import { OctoMark } from "../components/icons/OctoMark";
import { IconButton } from "../components/controls/IconButton";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { QuickViewEditor, replaceDoc } from "./QuickViewEditor";
import { QuickViewPreview } from "./QuickViewPreviews";
import {
  defaultLayout,
  fileName,
  formatJson,
  hasPreview,
  quickViewKind,
  relativeTo,
} from "./quickViewFormat";

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "unreadable"; path: string; reason: string }
  | { status: "ready"; path: string; initial: string };

type Conflict = null | "changed" | "deleted";

const LANG_LABEL: Partial<Record<LangId, string>> = {
  javascript: "TypeScript / JavaScript",
  plaintext: "Plain text",
  csharp: "C#",
  cpp: "C++",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Quick View — the standalone window a file opens in when the OS hands it to
 * Octopush (Finder "Open With", double-click, `octopush file.md`). No Atelier
 * shell: a header, the document, a status line. Source is always editable;
 * Markdown, CSV/TSV, SVG and HTML also render. ⌘S saves with the Review
 * editor's external-change guard; closing with unsaved edits asks first.
 */
export function QuickViewApp() {
  const loadTheme = useThemeStore((s) => s.load);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  // Errors land in the status line: Quick View mounts no toast host (the
  // app's toasts listen to session events that don't belong here).
  const [notice, setNotice] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceMatch | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [layout, setLayout] = useState<"preview" | "source">("source");

  const viewRef = useRef<EditorView | null>(null);
  const mtimeRef = useRef(0);
  const dirty = loaded.status === "ready" && content !== saved;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const path = loaded.status === "ready" || loaded.status === "unreadable" ? loaded.path : null;
  const kind = useMemo(() => (path ? quickViewKind(path) : "code"), [path]);
  const lang = useMemo(() => (path ? langForExtension(path) : "plaintext"), [path]);

  useEffect(() => {
    void loadTheme();
  }, [loadTheme]);

  // ── Load ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await ipc.quickviewPath();
        if (!p) {
          if (!cancelled) setLoaded({ status: "error", message: "This window has no file." });
          return;
        }
        const [read, ws] = await Promise.all([
          ipc.readFileChecked(p),
          ipc.workspaceForPath(p).catch(() => null),
        ]);
        if (cancelled) return;
        setWorkspace(ws);
        if (read.kind === "text") {
          mtimeRef.current = read.mtime;
          setContent(read.content);
          setSaved(read.content);
          setLayout(defaultLayout(quickViewKind(p)));
          setLoaded({ status: "ready", path: p, initial: read.content });
        } else {
          const reason =
            read.kind === "tooLarge"
              ? `Too large to open here (${formatBytes(read.size)}).`
              : read.kind === "binary"
                ? "A binary file — nothing to read as text."
                : "Not UTF-8 text.";
          setLoaded({ status: "unreadable", path: p, reason });
        }
      } catch (e) {
        if (!cancelled) setLoaded({ status: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Save ──
  const save = useCallback(
    async (force = false) => {
      if (loaded.status !== "ready" || saving) return false;
      const text = viewRef.current?.state.doc.toString() ?? content;
      setSaving(true);
      try {
        if (!force) {
          const meta = await ipc.fileMeta(loaded.path);
          if (meta && meta.mtimeMs !== mtimeRef.current) {
            setConflict("changed");
            return false;
          }
        }
        const r = await ipc.writeFile(loaded.path, text);
        mtimeRef.current = r.mtime;
        setSaved(text);
        setConflict(null);
        setNotice(null);
        return true;
      } catch (e) {
        setNotice(`Could not save: ${String(e)}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [loaded, saving, content],
  );

  const reload = useCallback(async () => {
    if (loaded.status !== "ready") return;
    const read = await ipc.readFileChecked(loaded.path);
    if (read.kind !== "text") return;
    mtimeRef.current = read.mtime;
    if (viewRef.current) replaceDoc(viewRef.current, read.content);
    setContent(read.content);
    setSaved(read.content);
    setConflict(null);
  }, [loaded]);

  // ⌘S while the preview has focus (the editor's own keymap covers source).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((isMac() ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // ── External changes: re-check when the window regains focus ──
  useEffect(() => {
    if (loaded.status !== "ready") return;
    const onFocus = async () => {
      const meta = await ipc.fileMeta(loaded.path).catch(() => undefined);
      if (meta === undefined) return;
      if (meta === null) {
        setConflict("deleted");
        return;
      }
      if (meta.mtimeMs === mtimeRef.current) return;
      if (dirtyRef.current) setConflict("changed");
      else void reload();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loaded, reload]);

  // ── Closing with unsaved edits asks first ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    ipc
      .onCloseRequested(() => {
        if (!dirtyRef.current) return true;
        setConfirmClose(true);
        return false;
      })
      .then((u) => {
        // Unmounted before registration landed (StrictMode's dry run).
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const onFormatJson = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const r = formatJson(view.state.doc.toString());
    if (r.ok) {
      setJsonError(null);
      replaceDoc(view, r.text);
    } else {
      setJsonError(r.error);
    }
  }, []);

  const onOpenInWorkspace = useCallback(async () => {
    if (!path) return;
    if (dirtyRef.current && !(await save())) return;
    const ok = await ipc.openPathInWorkspace(path).catch(() => false);
    if (!ok) setNotice("No workspace holds this file any more.");
  }, [path, save]);

  const onChange = useCallback((doc: string) => {
    setContent(doc);
    setJsonError(null);
  }, []);
  const onReady = useCallback((v: EditorView | null) => {
    viewRef.current = v;
  }, []);

  const name = path ? fileName(path) : "Quick View";
  const location = path
    ? workspace
      ? `${workspace.workspaceName} · ${relativeTo(workspace.root, path)}`
      : path
    : "";
  const lines = useMemo(() => content.split("\n").length, [content]);
  const showPreview = hasPreview(kind) && layout === "preview";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-octo-onyx text-octo-ivory">
      {/* Header — draggable; 78px reserves the macOS traffic lights. */}
      <header
        data-tauri-drag-region
        className={`flex h-10 shrink-0 items-center gap-2 border-b border-octo-hairline bg-octo-panel pr-3 ${
          isMac() ? "pl-[78px]" : "pl-3"
        }`}
      >
        <OctoMark size={16} state={saving ? "working" : "static"} />
        <span data-tauri-drag-region className="shrink-0 font-serif text-[14px] text-octo-ivory">
          {name}
        </span>
        {dirty && (
          <span
            className="octo-pop-in h-1.5 w-1.5 shrink-0 rounded-full bg-octo-brass"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        )}
        <span
          data-tauri-drag-region
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-mute"
          title={path ?? undefined}
        >
          {location}
        </span>

        {loaded.status === "ready" && hasPreview(kind) && (
          <div
            role="group"
            aria-label="Layout"
            className="flex shrink-0 items-center overflow-hidden rounded-md border"
            style={{ borderColor: "var(--brass-dim)" }}
          >
            {(
              [
                { value: "preview", Icon: Eye, title: "Preview" },
                { value: "source", Icon: Code2, title: "Source" },
              ] as const
            ).map(({ value, Icon, title }, i) => (
              <button
                key={value}
                type="button"
                onClick={() => setLayout(value)}
                aria-label={title}
                aria-pressed={layout === value}
                title={title}
                className={`flex items-center justify-center px-2 py-1 transition-colors focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-octo-brass ${
                  i > 0 ? "border-l border-octo-hairline" : ""
                } ${layout === value ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"}`}
                style={layout === value ? { background: "var(--brass-ghost)" } : undefined}
              >
                <Icon size={13} />
              </button>
            ))}
          </div>
        )}

        {loaded.status === "ready" && kind === "json" && (
          <IconButton label="Format JSON" onClick={onFormatJson}>
            <Braces size={13} />
          </IconButton>
        )}
        {loaded.status === "ready" && (
          <IconButton label={`Save (${modKeyLabel()}S)`} onClick={() => void save()} disabled={!dirty || saving}>
            <Save size={13} />
          </IconButton>
        )}
        {path && (
          <IconButton label="Reveal in Finder" onClick={() => void ipc.revealInFinder(path)}>
            <FolderOpen size={13} />
          </IconButton>
        )}
        {workspace && (
          <button
            type="button"
            onClick={() => void onOpenInWorkspace()}
            title={`Open in the ${workspace.workspaceName} workspace`}
            className="shrink-0 rounded-sm px-2 py-0.5 font-serif text-[13px] text-octo-brass transition-colors hover:bg-[var(--brass-ghost)] focus-visible:outline-1 focus-visible:outline-octo-brass"
          >
            Continue in the workspace
          </button>
        )}
      </header>

      {/* External change / deletion */}
      {conflict && (
        <div
          role="alert"
          className="octo-rise-in flex shrink-0 items-center gap-3 border-b border-octo-hairline bg-octo-panel px-4 py-2 font-mono text-[11px]"
        >
          <span className="flex-1 text-octo-warning">
            {conflict === "deleted"
              ? "This file was deleted on disk. Saving will recreate it."
              : "This file changed on disk since you opened it."}
          </span>
          {conflict === "changed" && (
            <button
              type="button"
              onClick={() => void reload()}
              className="font-serif text-[13px] text-octo-sage hover:text-octo-ivory"
            >
              Take the version on disk
            </button>
          )}
          <button
            type="button"
            onClick={() => void save(true)}
            className="font-serif text-[13px] text-octo-brass hover:text-octo-brass-hi"
          >
            {conflict === "deleted" ? "Save it again" : "Keep my edits"}
          </button>
        </div>
      )}

      {/* Body */}
      <main className="relative flex min-h-0 flex-1 flex-col">
        {loaded.status === "loading" && (
          <div className="flex flex-1 items-center justify-center">
            <OctoMark size={28} state="working" />
          </div>
        )}
        {loaded.status === "error" && (
          <div className="octo-fade-in flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <OctoMark size={40} state="blocked" />
            <p className="font-serif text-[16px] text-octo-ivory">This file could not be opened.</p>
            <p className="max-w-lg font-mono text-[11px] text-octo-mute">{loaded.message}</p>
          </div>
        )}
        {loaded.status === "unreadable" && (
          <div className="octo-fade-in flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <OctoMark size={40} />
            <p className="font-serif text-[16px] text-octo-ivory">Nothing to show here.</p>
            <p className="font-mono text-[11px] text-octo-mute">{loaded.reason}</p>
            <button
              type="button"
              onClick={() => void ipc.revealInFinder(loaded.path)}
              className="mt-2 font-serif text-[14px] text-octo-brass hover:text-octo-brass-hi"
            >
              Show it in Finder
            </button>
          </div>
        )}
        {loaded.status === "ready" && (
          <>
            {/* The editor never unmounts, so undo history and the caret
                survive switching to Preview and back. */}
            <div
              className="flex min-h-0 flex-1 flex-col"
              style={{ visibility: showPreview ? "hidden" : "visible" }}
            >
              <QuickViewEditor
                doc={loaded.initial}
                lang={lang}
                onChange={onChange}
                onSave={() => void save()}
                onReady={onReady}
              />
            </div>
            {showPreview && (
              <div key={layout} className="octo-fade-in absolute inset-0 flex flex-col overflow-hidden bg-octo-onyx">
                <QuickViewPreview kind={kind} source={content} />
              </div>
            )}
          </>
        )}
      </main>

      {/* Status line */}
      {loaded.status === "ready" && (
        <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-octo-hairline bg-octo-panel px-3 font-mono text-[10px] text-octo-mute">
          <span>{LANG_LABEL[lang] ?? lang}</span>
          <span>{lines.toLocaleString()} lines</span>
          <span className={dirty ? "text-octo-brass" : undefined}>
            {saving ? "saving" : dirty ? "unsaved" : "saved"}
          </span>
          {notice && (
            <span className="octo-fade-in min-w-0 truncate text-octo-danger" title={notice}>
              {notice}
            </span>
          )}
          {jsonError && (
            <span className="octo-fade-in min-w-0 truncate text-octo-danger" title={jsonError}>
              {jsonError}
            </span>
          )}
        </footer>
      )}

      {confirmClose && (
        <ConfirmDialog
          title="Unsaved changes"
          body={`${name} has edits that are not saved yet.`}
          destructiveLabel="Close without saving"
          cancelLabel="Keep editing"
          secondaryLabel="Save, then close"
          onSecondary={async () => {
            setConfirmClose(false);
            if (await save()) void ipc.destroyCurrentWindow();
          }}
          onConfirm={() => {
            setConfirmClose(false);
            void ipc.destroyCurrentWindow();
          }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </div>
  );
}
