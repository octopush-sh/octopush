import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiffSection } from "./FileDiffSection";
import { EmptyDiffState } from "./EmptyDiffState";
import { useDiffKeyboard, type FlatHunk } from "./useDiffKeyboard";
import { hunkFingerprint, type DiffFile } from "../../lib/diffParser";

export interface DiffAnchor { filePath: string; startLine: number; endLine: number; }

interface Props {
  /** True while REVIEW is the mode on screen. The canvas stays mounted under
   *  ModeOverlay, so without this the bare-letter hunk hotkeys (a/x/A) would
   *  accept or reject changes from TALK, RUN and DIRECT. */
  active?: boolean;
  files: DiffFile[];
  workspacePath: string;
  stagedCount?: number;
  onAccept: (filePath: string, hunkIdx: number) => void;
  onReject: (filePath: string, hunkIdx: number) => void;
  onWhy: (filePath: string, hunkIdx: number) => void;
  onOpen: (filePath: string, line: number) => void;
  onViewedChange?: (filePath: string, viewed: boolean) => void;
  onFocusFilter?: () => void;
  onFocusCommit?: () => void;
  anchorSlot?: (anchor: DiffAnchor, clear: () => void) => React.ReactNode;
}

export function DiffView(props: Props) {
  const { files, stagedCount = 0, active = true } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(0);
  // A viewed file maps to the fingerprints of the hunks it had when marked, so
  // a later agent edit (a hunk we haven't seen) can drop the mark.
  const [viewed, setViewed] = useState<Record<string, string[]>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [changed, setChanged] = useState<Record<string, boolean>>({});
  const [help, setHelp] = useState(false);

  // Marks belong to one workspace: the same path elsewhere starts unviewed.
  const [scope, setScope] = useState(props.workspacePath);
  if (scope !== props.workspacePath) {
    setScope(props.workspacePath);
    setViewed({});
    setCollapsed({});
    setChanged({});
  }

  // anchor: null until G5 anchor-selection task wires setAnchor.
  // Declared with setter so TypeScript does not warn about unused state.
  const [anchor, _setAnchor] = useState<DiffAnchor | null>(null);
  // _setAnchor is intentionally unused here; G5 will call it when wiring selection.
  void _setAnchor;

  const flat: FlatHunk[] = useMemo(
    () => files.flatMap((f, fi) => f.hunks.map((_, hi) => ({ fileIdx: fi, hunkIdx: hi }))),
    [files],
  );
  // Keep focus in range when the diff shrinks/grows after an accept/reject refetch,
  // so the focus ring and the next bare a/x act on a real hunk.
  useEffect(() => {
    setFocused((f) => Math.max(0, Math.min(f, flat.length - 1)));
  }, [flat.length]);
  const cur = flat[focused];
  const curFile = cur ? files[cur.fileIdx] : undefined;

  // After a refetch, a viewed file with a hunk it didn't have when marked was
  // changed again: unmark it and open it so the new hunks can't slip past.
  // Accepting or rejecting a hunk only removes fingerprints, so it keeps the mark.
  const onViewedChange = props.onViewedChange;
  useEffect(() => {
    const stale = files
      .filter((f) => viewed[f.filePath] && f.hunks.some((h) => !viewed[f.filePath].includes(hunkFingerprint(h))))
      .map((f) => f.filePath);
    if (stale.length === 0) return;
    const drop = (m: Record<string, string[]>) => {
      const next = { ...m };
      for (const p of stale) delete next[p];
      return next;
    };
    setViewed(drop);
    setCollapsed((m) => ({ ...m, ...Object.fromEntries(stale.map((p) => [p, false])) }));
    setChanged((m) => ({ ...m, ...Object.fromEntries(stale.map((p) => [p, true])) }));
    stale.forEach((p) => onViewedChange?.(p, false));
  }, [files, viewed, onViewedChange]);

  const toggleViewed = (file: DiffFile) => {
    const path = file.filePath;
    const v = !viewed[path];
    setViewed((m) => {
      const next = { ...m };
      if (v) next[path] = file.hunks.map(hunkFingerprint);
      else delete next[path];
      return next;
    });
    setCollapsed((m) => ({ ...m, [path]: v }));
    setChanged((m) => ({ ...m, [path]: false }));
    props.onViewedChange?.(path, v);
  };

  useDiffKeyboard({
    enabled: active && files.length > 0,
    flat,
    focused,
    setFocused,
    containerRef,
    actions: {
      accept: () => cur && props.onAccept(files[cur.fileIdx].filePath, cur.hunkIdx),
      reject: () => cur && props.onReject(files[cur.fileIdx].filePath, cur.hunkIdx),
      acceptFile: () => curFile && curFile.hunks.forEach((_, hi) => props.onAccept(curFile.filePath, hi)),
      toggleViewed: () => curFile && toggleViewed(curFile),
      open: () => cur && props.onOpen(files[cur.fileIdx].filePath, firstChangedLine(files[cur.fileIdx], cur.hunkIdx)),
      why: () => cur && props.onWhy(files[cur.fileIdx].filePath, cur.hunkIdx),
      toggleCollapse: () => curFile && setCollapsed((m) => ({ ...m, [curFile.filePath]: !m[curFile.filePath] })),
      focusFilter: () => props.onFocusFilter?.(),
      focusCommit: () => props.onFocusCommit?.(),
      toggleHelp: () => setHelp((h) => !h),
    },
  });

  if (files.length === 0) {
    return (
      <div className="absolute inset-0">
        <EmptyDiffState stagedCount={stagedCount} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="octo-fade-in absolute inset-0 overflow-y-auto outline-none"
      role="region"
      aria-label="Diff"
    >
      <div className="space-y-6 px-4 py-4">
        {files.map((file, fi) => (
          <FileDiffSection
            key={file.filePath}
            file={file}
            focusedHunk={cur?.fileIdx === fi ? cur.hunkIdx : -1}
            viewed={!!viewed[file.filePath]}
            collapsed={!!collapsed[file.filePath]}
            changedSinceViewed={!!changed[file.filePath] && !viewed[file.filePath]}
            onAccept={(hi) => props.onAccept(file.filePath, hi)}
            onReject={(hi) => props.onReject(file.filePath, hi)}
            onWhy={(hi) => props.onWhy(file.filePath, hi)}
            onToggleViewed={() => toggleViewed(file)}
            onToggleCollapsed={() => setCollapsed((m) => ({ ...m, [file.filePath]: !m[file.filePath] }))}
          />
        ))}
      </div>
      {help && <KeyboardHelp onClose={() => setHelp(false)} />}
      {anchor && props.anchorSlot?.(anchor, () => {
        /* clear handled when anchor selection lands in G5 */
      })}
    </div>
  );
}

function firstChangedLine(file: DiffFile, hunkIdx: number): number {
  const r = file.hunks[hunkIdx]?.rows.find((row) => row.kind !== "context");
  return r?.newLine ?? r?.oldLine ?? 1;
}

function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="octo-fade-in fixed bottom-4 right-4 z-50 rounded-md border border-octo-hairline bg-octo-panel p-3 font-mono text-[10px] text-octo-sage shadow-2xl"
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div className="mb-1 text-octo-brass">Keyboard · press ? to close</div>
      <div>j/k move · ]/[ file · Space fold · a accept · x reject · A file · v viewed · o open · w why</div>
      <button onClick={onClose} className="sr-only">Close</button>
    </div>
  );
}
