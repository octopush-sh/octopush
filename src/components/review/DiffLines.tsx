import { useMemo } from "react";
import { highlightHunk, overlaySegments, type DiffTok } from "../../lib/diffSyntax";
import type { DiffRow } from "../../lib/diffParser";
import type { ReadingMode } from "../../stores/reviewPrefsStore";

const ROW_BG: Record<DiffRow["kind"], string> = {
  add: "var(--verdigris-ghost)", del: "var(--rouge-ghost)", context: "transparent",
};
const ROW_FG: Record<DiffRow["kind"], string> = {
  add: "text-octo-verdigris", del: "text-octo-rouge", context: "text-octo-sage",
};

function renderText(row: DiffRow, toks: DiffTok[] | undefined) {
  let out = toks ?? [{ text: row.text, cls: "" }];
  if (row.segments && row.segments.length > 0) out = overlaySegments(out, row.segments);
  return out.map((tk, i) => <span key={i} className={tk.cls}>{tk.text}</span>);
}

/**
 * One hunk's rows. `tokens` (parallel to `rows`) comes from highlighting the
 * whole file (`highlightFile`); without it the hunk is highlighted in its
 * own context.
 */
/** Rows picked for a comment (#956): indexes into `rows`, inclusive. */
export interface RowPick { from: number; to: number }

/** A line number that starts a comment on its row (shift extends the pick). */
interface Pick {
  selected?: RowPick;
  onRowClick?: (rowIdx: number, extend: boolean) => void;
}

const inPick = (p: RowPick | undefined, i: number) => !!p && i >= Math.min(p.from, p.to) && i <= Math.max(p.from, p.to);
const PICKED = "inset 2px 0 0 var(--brass-dim)";

function LineNo({ n, i, pick }: { n: number | null; i: number; pick: Pick }) {
  const click = pick.onRowClick && n !== null ? pick.onRowClick : undefined;
  return (
    <span
      aria-hidden
      onClick={click ? (e) => click(i, e.shiftKey) : undefined}
      title={click ? "Ask for a change on this line (shift-click for a range)" : undefined}
      className={`min-w-[36px] select-none px-2 text-right text-octo-mute${click ? " cursor-pointer hover:text-octo-brass" : ""}`}
    >
      {n ?? ""}
    </span>
  );
}

export function DiffLines({ rows, filePath, mode, tokens, selected, onRowClick }: { rows: DiffRow[]; filePath: string; mode: ReadingMode; tokens?: DiffTok[][] } & Pick) {
  const own = useMemo(() => (tokens ? null : highlightHunk(rows, filePath)), [tokens, rows, filePath]);
  const toks = tokens ?? own!;
  const tokOf = new Map(rows.map((r, i) => [r, toks[i]]));
  const pick: Pick = { selected, onRowClick };
  if (mode === "sbs") return <SideBySide rows={rows} tokOf={tokOf} pick={pick} />;
  return (
    <pre className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      {rows.map((row, i) => (
        <div key={i} data-diff-row data-kind={row.kind} data-picked={inPick(selected, i) || undefined} className={`flex ${ROW_FG[row.kind]}`} style={{ background: ROW_BG[row.kind], boxShadow: inPick(selected, i) ? PICKED : undefined }}>
          <LineNo n={row.oldLine} i={i} pick={pick} />
          <LineNo n={row.newLine} i={i} pick={pick} />
          <span aria-hidden className="select-none pr-1 text-octo-mute">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
          <code className="flex-1 whitespace-pre pr-3">{renderText(row, toks[i])}</code>
        </div>
      ))}
    </pre>
  );
}

type TokOf = Map<DiffRow, DiffTok[]>;

function SideBySide({ rows, tokOf, pick }: { rows: DiffRow[]; tokOf: TokOf; pick: Pick }) {
  const idxOf = new Map(rows.map((r, i) => [r, i]));
  const left: (DiffRow | null)[] = [];
  const right: (DiffRow | null)[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "context") { left.push(r); right.push(r); i++; continue; }
    let d = i; while (d < rows.length && rows[d].kind === "del") d++;
    let a = d; while (a < rows.length && rows[a].kind === "add") a++;
    const dels = rows.slice(i, d), adds = rows.slice(d, a);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) { left.push(dels[k] ?? null); right.push(adds[k] ?? null); }
    i = a;
  }
  return (
    <div className="flex overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      <Col rows={left} side="old" tokOf={tokOf} idxOf={idxOf} pick={pick} />
      <div className="w-px shrink-0 bg-octo-hairline" />
      <Col rows={right} side="new" tokOf={tokOf} idxOf={idxOf} pick={pick} />
    </div>
  );
}

function Col({ rows, side, tokOf, idxOf, pick }: { rows: (DiffRow | null)[]; side: "old" | "new"; tokOf: TokOf; idxOf: Map<DiffRow, number>; pick: Pick }) {
  return (
    <div data-sbs-col className="min-w-0 flex-1">
      {rows.map((row, i) => {
        if (!row) return <div key={i} data-diff-row className="h-[1.55em] bg-octo-onyx/30" aria-hidden />;
        const ln = side === "old" ? row.oldLine : row.newLine;
        const ri = idxOf.get(row) ?? 0;
        return (
          <div key={i} data-diff-row data-kind={row.kind} data-picked={inPick(pick.selected, ri) || undefined} className={`flex whitespace-pre ${ROW_FG[row.kind]}`} style={{ background: ROW_BG[row.kind], boxShadow: inPick(pick.selected, ri) ? PICKED : undefined }}>
            <LineNo n={ln} i={ri} pick={pick} />
            <code className="flex-1 pr-3">{renderText(row, tokOf.get(row))}</code>
          </div>
        );
      })}
    </div>
  );
}
