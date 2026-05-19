/**
 * WorkspaceSearchPalette — fuzzy file finder + workspace-wide text search.
 *
 * Two modes:
 *   - "files"  → list every non-ignored file in the workspace, fuzzy-filter
 *                client-side (cmdk's scorer). Open the selected file in
 *                the in-app editor.
 *   - "text"   → ask the backend to scan every text file for a literal
 *                substring (case-insensitive), render hits with line +
 *                preview. Open the file at that line.
 *
 * Opened from App via Cmd+P (files) or Cmd+Shift+F (text). Esc closes;
 * Tab toggles between modes without losing the typed query.
 */

import { Command } from "cmdk";
import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { SearchHit } from "../lib/types";

type Mode = "files" | "text";

interface Props {
  /** Workspace root — used as the base for both file listing and text search. */
  workspacePath: string;
  /** Initial mode determines which palette opens. */
  initialMode: Mode;
  open: boolean;
  onClose: () => void;
  /** Called when the user selects a result. The path is relative to the
   *  workspace root; the parent typically routes through Review → Editor. */
  onOpenFile: (relativePath: string) => void;
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

  // File-mode catalog: loaded once per open, then cmdk filters client-side.
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

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, mode]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      setMode((m) => (m === "files" ? "text" : "files"));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
      style={{ background: "rgba(12, 10, 8, 0.55)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[640px] rounded-xl bg-octo-panel"
        style={{
          border: "1px solid var(--brass-dim)",
          boxShadow:
            "0 30px 60px -10px rgba(0,0,0,0.6), 0 0 0 6px rgba(212, 165, 116, 0.04)",
        }}
      >
        <Command
          loop
          shouldFilter={mode === "files"} // text mode is server-filtered
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
              placeholder={
                mode === "files"
                  ? "Search files by path…"
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
            <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
              Tab to toggle
            </span>
          </div>

          {/* Results */}
          <Command.List className="max-h-[420px] overflow-y-auto py-2">
            {mode === "files" ? (
              <FilesResults
                files={files}
                loading={filesLoading}
                onSelect={(path) => {
                  onClose();
                  onOpenFile(path);
                }}
              />
            ) : (
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
                  onOpenFile(hit.file);
                }}
              />
            )}
          </Command.List>
        </Command>
      </div>
    </div>
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
  files,
  loading,
  onSelect,
}: {
  files: string[];
  loading: boolean;
  onSelect: (path: string) => void;
}) {
  if (loading && files.length === 0) {
    return (
      <div className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        Scanning workspace…
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <Command.Empty className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        No files in this workspace.
      </Command.Empty>
    );
  }
  return (
    <>
      <Command.Empty className="px-6 py-8 text-center font-serif text-[13px] text-octo-mute">
        No matching files.
      </Command.Empty>
      {files.map((path) => {
        const slash = path.lastIndexOf("/");
        const dir = slash >= 0 ? path.slice(0, slash) : "";
        const name = slash >= 0 ? path.slice(slash + 1) : path;
        return (
          <Command.Item
            key={path}
            value={path}
            onSelect={() => onSelect(path)}
            className="mx-1 flex cursor-pointer items-baseline gap-2 rounded-md px-3 py-1.5 text-[12.5px] text-octo-sage aria-selected:text-octo-ivory"
          >
            <span className="truncate font-mono text-octo-ivory">{name}</span>
            {dir && (
              <span className="truncate font-mono text-[11px] text-octo-mute">
                {dir}
              </span>
            )}
          </Command.Item>
        );
      })}
    </>
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
