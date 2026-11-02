/**
 * WorkspaceSearchPalette — fuzzy file finder + workspace-wide text search.
 *
 * Two modes:
 *   - "files"  → list every non-ignored file in the workspace, filter and
 *                rank client-side with `lib/fileMatch` (globs, fzf-style
 *                fuzzy terms, `file:line[:col]`). The list is virtualized:
 *                only the rows in view are in the DOM. Open the selected
 *                file in the in-app editor.
 *   - "text"   → ask the backend to scan every text file for a literal
 *                substring (case-insensitive), render hits with line +
 *                preview. Open the file at that line.
 *
 * Opened from App via Cmd+P (files) or Cmd+Shift+F (text). Esc closes;
 * Tab toggles between modes without losing the typed query.
 */

import { Command } from "cmdk";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  FILE_LIST_CAP,
  matchFiles,
  parseQuery,
  prepareFiles,
  type FileMatch,
} from "../lib/fileMatch";
import { ipc } from "../lib/ipc";
import type { SearchHit } from "../lib/types";
import { useEditorStore } from "../stores/editorStore";
import { useRecentFilesStore } from "../stores/recentFilesStore";
import { ModalShell } from "./ModalShell";

type Mode = "files" | "text";

/** Fixed row height and viewport for the virtualized file list. */
const ROW_HEIGHT = 30;
const LIST_HEIGHT = 420;
const LIST_PAD = 8;
const OVERSCAN = 8;

const EMPTY_PATHS: string[] = [];

interface Props {
  /** Workspace root — used as the base for both file listing and text search. */
  workspacePath: string;
  /** Initial mode determines which palette opens. */
  initialMode: Mode;
  open: boolean;
  onClose: () => void;
  /** Called when the user selects a result. The path is relative to the
   *  workspace root; the parent typically routes through Review → Editor.
   *  `line` (1-based) is set for text hits, so the editor opens ON the match
   *  rather than at the top of the file — the whole point of picking a hit.
   *  `col` (1-based) is set when a file query ends in `:line:col`. */
  onOpenFile: (relativePath: string, line?: number, col?: number) => void;
}

export function WorkspaceSearchPalette({
  workspacePath,
  initialMode,
  open,
  onClose,
  onOpenFile,
}: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [query, setQuery] = useState("");

  // File-mode catalog: loaded once per open, then ranked client-side.
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // Text-mode results: re-fetched on debounced query change.
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);

  // Reset state whenever the palette opens, switching modes inherits the
  // query so a user typing "foo" can hit Tab to switch immediately.
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setQuery("");
    setHits([]);
    setTextError(null);
  }, [open, initialMode]);

  // Load file list on entry to "files" mode.
  useEffect(() => {
    if (!open || mode !== "files") return;
    setFilesLoading(true);
    ipc
      .listWorkspaceFiles(workspacePath)
      .then((paths) => setFiles(paths))
      .catch((e) => console.error("list files failed:", e))
      .finally(() => setFilesLoading(false));
  }, [open, mode, workspacePath]);

  // Debounced text search.
  useEffect(() => {
    if (!open || mode !== "text") return;
    if (!query.trim()) {
      setHits([]);
      setTextError(null);
      return;
    }
    let cancelled = false;
    setTextLoading(true);
    const id = setTimeout(() => {
      ipc
        .searchWorkspaceText(workspacePath, query, false)
        .then((results) => {
          if (cancelled) return;
          setHits(results);
          setTextError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setTextError(String(e));
        })
        .finally(() => {
          if (!cancelled) setTextLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [open, mode, query, workspacePath]);

  // File-mode ranking. Prepared once per listing; the query is deferred so a
  // keystroke paints before 20k paths are re-scored.
  const prepared = useMemo(() => prepareFiles(files), [files]);
  const deferredQuery = useDeferredValue(query);
  const parsed = useMemo(
    () => parseQuery(deferredQuery, workspacePath),
    [deferredQuery, workspacePath],
  );
  // Ties go to open tabs, then to files recently opened from here.
  const filesByWs = useEditorStore((s) => s.filesByWs);
  const recent = useRecentFilesStore((s) => s.byWs[workspacePath] ?? EMPTY_PATHS);
  const recordRecent = useRecentFilesStore((s) => s.record);
  const boost = useMemo(() => {
    const root = workspacePath.replace(/\/+$/, "") + "/";
    const tabs: string[] = [];
    for (const list of Object.values(filesByWs)) {
      for (const f of list) if (f.path.startsWith(root)) tabs.push(f.path.slice(root.length));
    }
    return [...tabs, ...recent];
  }, [filesByWs, recent, workspacePath]);
  const matches = useMemo(
    () => (mode === "files" ? matchFiles(prepared, parsed, boost) : []),
    [mode, prepared, parsed, boost],
  );
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [matches]);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, mode]);

  if (!open) return null;

  const openMatch = (path: string, at = parsed) => {
    onClose();
    recordRecent(workspacePath, path);
    if (at.line === undefined) onOpenFile(path);
    else if (at.col === undefined) onOpenFile(path, at.line);
    else onOpenFile(path, at.line, at.col);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Escape is handled by ModalShell; Tab toggles files/text mode.
    if (e.key === "Tab") {
      e.preventDefault();
      setMode((m) => (m === "files" ? "text" : "files"));
      return;
    }
    // The virtualized file list keeps its own selection (cmdk only sees the
    // rows it renders, so it can't walk 20k of them).
    if (mode !== "files") return;
    if (e.key === "Enter") {
      e.preventDefault();
      // Enter right after a keystroke must act on what was typed, not on the
      // deferred ranking still catching up.
      if (deferredQuery !== query) {
        const now = parseQuery(query, workspacePath);
        const top = matchFiles(prepared, now, boost)[0];
        if (top) openMatch(top.path, now);
        return;
      }
      const pick = matches[Math.min(selected, matches.length - 1)];
      if (pick) openMatch(pick.path);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length > 0) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSelected((i) => (i + step + matches.length) % matches.length);
    }
  };

  const capped = files.length >= FILE_LIST_CAP;

  return (
    <ModalShell onClose={onClose} align="top" topOffset="pt-[14vh]" ariaLabel="Search workspace">
      <div
        onKeyDown={handleKeyDown}
        className="w-[640px] rounded-xl bg-octo-panel"
        style={{
          border: "1px solid var(--brass-dim)",
          boxShadow:
            "0 30px 60px -10px rgba(0,0,0,0.6), 0 0 0 6px rgba(212, 165, 116, 0.04)",
        }}
      >
        <Command
          loop
          // Files are ranked by lib/fileMatch, text by the backend.
          shouldFilter={false}
          className="overflow-hidden rounded-xl"
        >
          {/* Header — eyebrow, input, esc hint. */}
          <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
              {mode === "files" ? "⌘ P" : "⌘ ⇧ F"}
            </span>
            <Command.Input
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              data-tour="file-finder-input"
              placeholder={
                mode === "files"
                  ? "Search files: name, *.java, src/**/*.ts, Foo.java:42…"
                  : "Search text in every file…"
              }
              className="flex-1 bg-transparent font-serif text-[14px] text-octo-ivory outline-none placeholder:text-octo-mute"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute transition-colors hover:border-octo-brass hover:text-octo-brass"
            >
              ESC
            </button>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center gap-1 border-b border-octo-hairline px-2 py-1.5">
            <ModeTab
              active={mode === "files"}
              label="Files"
              count={files.length || undefined}
              onClick={() => setMode("files")}
            />
            <ModeTab
              active={mode === "text"}
              label="Text"
              count={mode === "text" && query ? hits.length : undefined}
              onClick={() => setMode("text")}
            />
            {mode === "files" && capped && (
              <span
                data-tour="file-finder-capped"
                className="ml-2 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute"
              >
                Showing the first {FILE_LIST_CAP.toLocaleString("en-US")} files
              </span>
            )}
            <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
              Tab to toggle
            </span>
          </div>

          {/* Results */}
          {mode === "files" ? (
            <FilesResults
              total={files.length}
              matches={matches}
              loading={filesLoading}
              selected={selected}
              line={parsed.line}
              onHover={setSelected}
              onSelect={(path) => openMatch(path)}
            />
          ) : (
            <Command.List className="max-h-[420px] overflow-y-auto py-2">
              <TextResults
                hits={hits}
                loading={textLoading}
                error={textError}
                emptyHint={
                  query.trim()
                    ? null
                    : "Type to search text across every file."
                }
                onSelect={(hit) => {
                  onClose();
                  onOpenFile(hit.file, hit.line);
                }}
              />
            </Command.List>
          )}
        </Command>
      </div>
    </ModalShell>
  );
}

// ─── Mode tab ──────────────────────────────────────────────────────

function ModeTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors"
      style={{
        color: active ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
        background: active ? "var(--brass-ghost)" : "transparent",
        border: active
          ? "1px solid var(--brass-dim)"
          : "1px solid transparent",
      }}
    >
      <span>{label}</span>
      {typeof count === "number" && (
        <span className="font-mono text-[9px] opacity-70">· {count}</span>
      )}
    </button>
  );
}

// ─── Files results ─────────────────────────────────────────────────

function FilesResults({
  total,
  matches,
  loading,
  selected,
  line,
  onHover,
  onSelect,
}: {
  total: number;
  matches: FileMatch[];
  loading: boolean;
  selected: number;
  /** From a `file:line` query — shown after each name. */
  line?: number;
  onHover: (index: number) => void;
  onSelect: (path: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Keep the keyboard selection in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = LIST_PAD + selected * ROW_HEIGHT;
    if (top < el.scrollTop + LIST_PAD) el.scrollTop = top - LIST_PAD;
    else if (top + ROW_HEIGHT + LIST_PAD > el.scrollTop + LIST_HEIGHT) {
      el.scrollTop = top + ROW_HEIGHT + LIST_PAD - LIST_HEIGHT;
    }
  }, [selected]);

  // A new ranking starts at the top.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [matches]);

  if (loading && total === 0) {
    return (
      <div className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        Scanning workspace…
      </div>
    );
  }
  if (total === 0 || matches.length === 0) {
    return (
      <div className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        {total === 0 ? "No files in this workspace." : "No matching files."}
      </div>
    );
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    matches.length,
    Math.ceil((scrollTop + LIST_HEIGHT) / ROW_HEIGHT) + OVERSCAN,
  );
  const rows = [];
  for (let i = first; i < last; i++) {
    const { path } = matches[i];
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    rows.push(
      <div
        key={path}
        id={`file-finder-row-${i}`}
        role="option"
        aria-selected={i === selected}
        onMouseMove={() => i !== selected && onHover(i)}
        onClick={() => onSelect(path)}
        className="absolute inset-x-1 flex cursor-pointer items-center gap-2 rounded-md px-3 text-[12.5px] text-octo-sage aria-selected:text-octo-ivory"
        style={{ top: LIST_PAD + i * ROW_HEIGHT, height: ROW_HEIGHT }}
      >
        <span className="truncate font-mono text-octo-ivory">{name}</span>
        {line !== undefined && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass">
            :{line}
          </span>
        )}
        {dir && (
          <span className="truncate font-mono text-[11px] text-octo-mute">
            {dir}
          </span>
        )}
      </div>,
    );
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Matching files"
      aria-activedescendant={`file-finder-row-${selected}`}
      data-tour="file-finder-results"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="overflow-y-auto"
      style={{ maxHeight: LIST_HEIGHT }}
    >
      <div className="relative" style={{ height: matches.length * ROW_HEIGHT + 2 * LIST_PAD }}>
        {rows}
      </div>
    </div>
  );
}

// ─── Text results ──────────────────────────────────────────────────

function TextResults({
  hits,
  loading,
  error,
  emptyHint,
  onSelect,
}: {
  hits: SearchHit[];
  loading: boolean;
  error: string | null;
  emptyHint: string | null;
  onSelect: (hit: SearchHit) => void;
}) {
  if (error) {
    return (
      <div className="px-6 py-8 text-center font-serif text-[13px] text-octo-rouge">
        {error}
      </div>
    );
  }
  if (emptyHint) {
    return (
      <div className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        {emptyHint}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        Searching…
      </div>
    );
  }
  if (hits.length === 0) {
    return (
      <div className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        No matches.
      </div>
    );
  }
  return (
    <>
      {hits.map((hit, i) => (
        <Command.Item
          key={`${hit.file}:${hit.line}:${i}`}
          // Disable cmdk's filtering for text-mode by using a stable value.
          value={`${hit.file}-${hit.line}-${i}`}
          onSelect={() => onSelect(hit)}
          className="mx-1 flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-1.5 text-[12.5px] text-octo-sage aria-selected:text-octo-ivory"
        >
          <div className="flex items-baseline gap-2">
            <span className="truncate font-mono text-[12px] text-octo-ivory">
              {hit.file}
            </span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass">
              :{hit.line}
            </span>
          </div>
          <div className="truncate font-mono text-[11px] leading-[1.5] text-octo-sage">
            {hit.preview}
          </div>
        </Command.Item>
      ))}
    </>
  );
}
