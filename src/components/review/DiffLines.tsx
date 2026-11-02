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
export function DiffLines({ rows, filePath, mode, tokens }: { rows: DiffRow[]; filePath: string; mode: ReadingMode; tokens?: DiffTok[][] }) {
  const own = useMemo(() => (tokens ? null : highlightHunk(rows, filePath)), [tokens, rows, filePath]);
  const toks = tokens ?? own!;
  const tokOf = new Map(rows.map((r, i) => [r, toks[i]]));
  if (mode === "sbs") return <SideBySide rows={rows} tokOf={tokOf} />;
  return (
    <pre className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      {rows.map((row, i) => (
        <div key={i} data-diff-row data-kind={row.kind} className={`flex ${ROW_FG[row.kind]}`} style={{ background: ROW_BG[row.kind] }}>
          <span aria-hidden className="min-w-[36px] select-none px-2 text-right text-octo-mute">{row.oldLine ?? ""}</span>
          <span aria-hidden className="min-w-[36px] select-none px-2 text-right text-octo-mute">{row.newLine ?? ""}</span>
          <span aria-hidden className="select-none pr-1 text-octo-mute">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
          <code className="flex-1 whitespace-pre pr-3">{renderText(row, toks[i])}</code>
        </div>
      ))}
    </pre>
  );
}

type TokOf = Map<DiffRow, DiffTok[]>;

function SideBySide({ rows, tokOf }: { rows: DiffRow[]; tokOf: TokOf }) {
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
      <Col rows={left} side="old" tokOf={tokOf} />
      <div className="w-px shrink-0 bg-octo-hairline" />
      <Col rows={right} side="new" tokOf={tokOf} />
    </div>
  );
}

function Col({ rows, side, tokOf }: { rows: (DiffRow | null)[]; side: "old" | "new"; tokOf: TokOf }) {
  return (
    <div data-sbs-col className="min-w-0 flex-1">
      {rows.map((row, i) => {
        if (!row) return <div key={i} data-diff-row className="h-[1.55em] bg-octo-onyx/30" aria-hidden />;
        const ln = side === "old" ? row.oldLine : row.newLine;
        return (
          <div key={i} data-diff-row data-kind={row.kind} className={`flex whitespace-pre ${ROW_FG[row.kind]}`} style={{ background: ROW_BG[row.kind] }}>
            <span aria-hidden className="min-w-[36px] select-none px-2 text-right text-octo-mute">{ln ?? ""}</span>
            <code className="flex-1 pr-3">{renderText(row, tokOf.get(row))}</code>
          </div>
        );
      })}
    </div>
  );
}
