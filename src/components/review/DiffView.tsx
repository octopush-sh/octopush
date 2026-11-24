import { useEffect, useMemo, useRef, useState } from "react";
import { FileDiffSection } from "./FileDiffSection";
import { EmptyDiffState, type EmptyDiffContext } from "./EmptyDiffState";
import { useDiffKeyboard, type FlatHunk } from "./useDiffKeyboard";
import { hunkFingerprint, type DiffFile } from "../../lib/diffParser";
import { commentAnchor, liveHunkKeys, reanchorDraft, stepPick, type CommentDraft } from "../../lib/reviewComments";
import { pushToast } from "../Toasts";
import { selectComments, useReviewComments } from "../../stores/reviewCommentsStore";

export interface DiffAnchor { filePath: string; startLine: number; endLine: number; }

interface Props {
  /** True while REVIEW is the mode on screen. The canvas stays mounted under
   *  ModeOverlay, so without this the bare-letter hunk hotkeys (a/x/A) would
   *  accept or reject changes from TALK, RUN and DIRECT. */
  active?: boolean;
  files: DiffFile[];
  workspacePath: string;
  /** Turns on review comments (#956) in the working-tree view: their tray is
   *  per workspace. */
  workspaceId?: string;
  /** The workspace `files` were fetched for; null while none is (a switch
   *  with its fetch in flight, or a mode that fetches no diff). Until it is
   *  `workspaceId`, the diff on screen says nothing about that workspace's
   *  draft. Left out, `files` are taken as `workspaceId`'s. */
  diffWorkspaceId?: string | null;
  stagedCount?: number;
  /** The committed view (#851): no Accept / Reject, by click or key. */
  readOnly?: boolean;
  /** Highlight hunks in the context of the file on disk (default true). Off
   *  when the disk no longer matches the diff's new side. */
  diskContext?: boolean;
  /** What the empty state says: which source, and what the other one holds. */
  empty?: EmptyDiffContext;
  onShowCommitted?: () => void;
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
  const { files, stagedCount = 0, active = true, readOnly = false, diskContext = true } = props;
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

  // Comments act on the working tree only; the committed view is out of scope.
  const commentWs = !readOnly ? props.workspaceId : undefined;
  const comments = useReviewComments(selectComments(commentWs ?? ""));
  // The open "Ask for a change" draft: its hunk, the rows picked (if any),
  // the anchor taken at that moment and the note typed so far. It lives in
  // the store, per workspace, not in the field or this view: nothing that
  // remounts the field loses the note, and a workspace switch under the view
  // leaves it waiting in its own workspace (#1051).
  // Right after a workspace switch, `files` are still the previous
  // workspace's diff, then empty until the new fetch lands: reading the
  // draft against them would move it to the wrong hunk or into the tray.
  const ownDiff = props.diffWorkspaceId === undefined || props.diffWorkspaceId === commentWs;
  const stored = useReviewComments((s) => (commentWs ? s.draftByWs[commentWs] ?? null : null));
  const draft = ownDiff ? stored : null;
  const setDraft = (next: CommentDraft | null | ((d: CommentDraft | null) => CommentDraft | null)) => {
    if (commentWs) useReviewComments.getState().setDraft(commentWs, next);
  };
  useEffect(() => {
    if (commentWs && ownDiff) useReviewComments.getState().setLive(commentWs, liveHunkKeys(files));
  }, [commentWs, ownDiff, files]);
  // A refetch (the agent is still editing) must not take a half-typed note
  // away: the draft follows its hunk, stays open as outdated when the hunk
  // changed, and is kept in the tray when its file left the diff.
  useEffect(() => {
    if (!commentWs || !draft) return;
    const next = reanchorDraft(draft, files);
    if (next === draft) return;
    if (next === null && draft.note.trim()) {
      useReviewComments.getState().add(commentWs, { ...draft.anchor, note: draft.note.trim() });
      pushToast({
        level: "info",
        title: "Your comment was kept",
        body: "Its file left the diff while you were writing. It is in the tray, marked outdated.",
      });
    }
    setDraft(next);
  }, [commentWs, draft, files]);
  // Opening on another place (another line, another hunk) moves the draft
  // there with the note typed so far. A folded file opens to show the field.
  const startComment = (filePath: string, hunkIdx: number, rowIdx?: number, extend = false) => {
    const hunk = files.find((f) => f.filePath === filePath)?.hunks[hunkIdx];
    if (!commentWs || !hunk) return;
    setDraft((d) => {
      const same = d && !d.stale && d.filePath === filePath && d.hunkIdx === hunkIdx;
      const rows = rowIdx === undefined ? undefined : extend && same && d.rows ? { from: d.rows.from, to: rowIdx } : { from: rowIdx, to: rowIdx };
      return { filePath, hunkIdx, rows, anchor: commentAnchor(filePath, hunk, rows), note: d?.note ?? "", stale: false };
    });
    setCollapsed((m) => (m[filePath] ? { ...m, [filePath]: false } : m));
  };
  // ⌥↑ / ⌥↓ in the field (⇧ extends): the keyboard's way to pick lines. The
  // draft moves within its hunk, as a click on a line number would move it.
  const movePick = (dir: -1 | 1, extend: boolean) => {
    if (!draft) return;
    const hunk = files.find((f) => f.filePath === draft.filePath)?.hunks[draft.hunkIdx];
    if (!hunk) return;
    const rows = stepPick(draft.stale ? undefined : draft.rows, hunk.rows.length, dir, extend);
    if (rows && draft.rows && !draft.stale && rows.from === draft.rows.from && rows.to === draft.rows.to) return;
    setDraft({ ...draft, rows, anchor: commentAnchor(draft.filePath, hunk, rows), stale: false });
  };
  const submitComment = () => {
    if (!commentWs || !draft || !draft.note.trim()) return;
    useReviewComments.getState().add(commentWs, { ...draft.anchor, note: draft.note.trim() });
    setDraft(null);
  };

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
      accept: () => !readOnly && cur && props.onAccept(files[cur.fileIdx].filePath, cur.hunkIdx),
      reject: () => !readOnly && cur && props.onReject(files[cur.fileIdx].filePath, cur.hunkIdx),
      acceptFile: () => !readOnly && curFile && curFile.hunks.forEach((_, hi) => props.onAccept(curFile.filePath, hi)),
      toggleViewed: () => curFile && toggleViewed(curFile),
      open: () => cur && props.onOpen(files[cur.fileIdx].filePath, firstChangedLine(files[cur.fileIdx], cur.hunkIdx)),
      why: () => cur && props.onWhy(files[cur.fileIdx].filePath, cur.hunkIdx),
      ...(commentWs && { comment: () => cur && startComment(files[cur.fileIdx].filePath, cur.hunkIdx) }),
      toggleCollapse: () => curFile && setCollapsed((m) => ({ ...m, [curFile.filePath]: !m[curFile.filePath] })),
      focusFilter: () => props.onFocusFilter?.(),
      focusCommit: () => props.onFocusCommit?.(),
      toggleHelp: () => setHelp((h) => !h),
    },
  });

  if (files.length === 0) {
    return (
      <div className="absolute inset-0">
        <EmptyDiffState stagedCount={stagedCount} context={props.empty} onShowCommitted={props.onShowCommitted} />
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
            workspacePath={diskContext ? props.workspacePath : undefined}
            readOnly={readOnly}
            focusedHunk={cur?.fileIdx === fi ? cur.hunkIdx : -1}
            viewed={!!viewed[file.filePath]}
            collapsed={!!collapsed[file.filePath]}
            changedSinceViewed={!!changed[file.filePath] && !viewed[file.filePath]}
            onAccept={(hi) => props.onAccept(file.filePath, hi)}
            onReject={(hi) => props.onReject(file.filePath, hi)}
            onWhy={(hi) => props.onWhy(file.filePath, hi)}
            onToggleViewed={() => toggleViewed(file)}
            onToggleCollapsed={() => setCollapsed((m) => ({ ...m, [file.filePath]: !m[file.filePath] }))}
            {...(commentWs && {
              draft: draft?.filePath === file.filePath ? draft : null,
              comments: comments.filter((c) => c.filePath === file.filePath),
              onStartComment: (hi: number, ri?: number, extend?: boolean) => startComment(file.filePath, hi, ri, extend),
              onDraftNote: (note: string) => setDraft((d) => (d ? { ...d, note } : d)),
              onMovePick: movePick,
              onSubmitComment: submitComment,
              onCancelComment: () => setDraft(null),
              onRemoveComment: (id: string) => useReviewComments.getState().remove(commentWs, id),
            })}
          />
        ))}
      </div>
      {help && <KeyboardHelp readOnly={readOnly} onClose={() => setHelp(false)} />}
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

/** The `?` overlay. The committed view is read-only, so it leaves out the
 *  accept / reject keys it ignores (#903). Exported for tests. */
export function keyboardHelpLine(readOnly: boolean): string {
  const act = readOnly ? "" : " · a accept · x reject · A file";
  const ask = readOnly ? "" : " · m ask for a change (in it, ⌥↑ ⌥↓ pick lines)";
  return `j/k move · ]/[ file · Space fold${act} · v viewed · o open · w why${ask}`;
}

function KeyboardHelp({ readOnly, onClose }: { readOnly: boolean; onClose: () => void }) {
  return (
    <div
      className="octo-fade-in fixed bottom-4 right-4 z-50 rounded-md border border-octo-hairline bg-octo-panel p-3 font-mono text-[10px] text-octo-sage shadow-2xl"
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div className="mb-1 text-octo-brass">Keyboard · press ? to close</div>
      <div>{keyboardHelpLine(readOnly)}</div>
      <button onClick={onClose} className="sr-only">Close</button>
    </div>
  );
}
