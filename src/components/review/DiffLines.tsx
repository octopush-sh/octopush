import { highlightLine } from "../../lib/diffHighlight";
import type { DiffRow } from "../../lib/diffParser";
import type { WordSegment } from "../../lib/wordDiff";
import type { ReadingMode } from "../../stores/reviewPrefsStore";

const ROW_BG: Record<DiffRow["kind"], string> = {
  add: "var(--verdigris-ghost)", del: "var(--rouge-ghost)", context: "transparent",
};
const ROW_FG: Record<DiffRow["kind"], string> = {
  add: "text-octo-verdigris", del: "text-octo-rouge", context: "text-octo-sage",
};

function renderText(row: DiffRow, filePath: string) {
  if (row.segments && row.segments.length > 0) {
    return row.segments.map((s: WordSegment, i) => (
      <span key={i} className={s.kind === "equal" ? "" : s.kind === "add" ? "wd-add" : "wd-del"}>{s.text}</span>
    ));
  }
  return highlightLine(row.text, filePath).map((tk, i) => (
    <span key={i} className={tk.cls}>{tk.text}</span>
  ));
}

export function DiffLines({ rows, filePath, mode }: { rows: DiffRow[]; filePath: string; mode: ReadingMode }) {
  if (mode === "sbs") return <SideBySide rows={rows} filePath={filePath} />;
  return (
    <pre className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
      {rows.map((row, i) => (
        <div key={i} data-diff-row data-kind={row.kind} className={`flex ${ROW_FG[row.kind]}`} style={{ background: ROW_BG[row.kind] }}>
          <span aria-hidden className="min-w-[36px] select-none px-2 text-right text-octo-mute">{row.oldLine ?? ""}</span>
          <span aria-hidden className="min-w-[36px] select-none px-2 text-right text-octo-mute">{row.newLine ?? ""}</span>
          <span aria-hidden className="select-none pr-1 text-octo-mute">{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</span>
          <code className="flex-1 whitespace-pre pr-3">{renderText(row, filePath)}</code>
        </div>
      ))}
    </pre>
  );
}

function SideBySide({ rows, filePath }: { rows: DiffRow[]; filePath: string }) {
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
      <Col rows={left} side="old" filePath={filePath} />
      <div className="w-px shrink-0 bg-octo-hairline" />
      <Col rows={right} side="new" filePath={filePath} />
    </div>
  );
}

function Col({ rows, side, filePath }: { rows: (DiffRow | null)[]; side: "old" | "new"; filePath: string }) {
  return (
    <div data-sbs-col className="min-w-0 flex-1">
      {rows.map((row, i) => {
        if (!row) return <div key={i} data-diff-row className="h-[1.55em] bg-octo-onyx/30" aria-hidden />;
        const ln = side === "old" ? row.oldLine : row.newLine;
        return (
          <div key={i} data-diff-row data-kind={row.kind} className={`flex whitespace-pre ${ROW_FG[row.kind]}`} style={{ background: ROW_BG[row.kind] }}>
            <span aria-hidden className="min-w-[36px] select-none px-2 text-right text-octo-mute">{ln ?? ""}</span>
            <code className="flex-1 pr-3">{renderText(row, filePath)}</code>
          </div>
        );
      })}
    </div>
  );
}
