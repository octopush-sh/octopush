import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiffSection } from "./FileDiffSection";
import { EmptyDiffState } from "./EmptyDiffState";
import { useDiffKeyboard, type FlatHunk } from "./useDiffKeyboard";
import type { DiffFile } from "../../lib/diffParser";

export interface DiffAnchor { filePath: string; startLine: number; endLine: number; }

interface Props {
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
  const { files, stagedCount = 0 } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(0);
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [help, setHelp] = useState(false);

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

  const toggleViewed = (path: string) => {
    const v = !viewed[path];
    setViewed((m) => ({ ...m, [path]: v }));
    setCollapsed((m) => ({ ...m, [path]: v }));
    props.onViewedChange?.(path, v);
  };

  useDiffKeyboard({
    enabled: files.length > 0,
    flat,
    focused,
    setFocused,
    containerRef,
    actions: {
      accept: () => cur && props.onAccept(files[cur.fileIdx].filePath, cur.hunkIdx),
      reject: () => cur && props.onReject(files[cur.fileIdx].filePath, cur.hunkIdx),
      acceptFile: () => curFile && curFile.hunks.forEach((_, hi) => props.onAccept(curFile.filePath, hi)),
      toggleViewed: () => curFile && toggleViewed(curFile.filePath),
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
            onAccept={(hi) => props.onAccept(file.filePath, hi)}
            onReject={(hi) => props.onReject(file.filePath, hi)}
            onWhy={(hi) => props.onWhy(file.filePath, hi)}
            onToggleViewed={() => toggleViewed(file.filePath)}
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
