import { useMemo } from "react";
import { MarkdownPreview } from "../components/editor/MarkdownPreview";
import { parseDelimited, type QuickViewKind } from "./quickViewFormat";

/** Rows rendered before the table stops (the source stays fully editable). */
const MAX_TABLE_ROWS = 2000;

/** First row as a sticky header; every other row in the body. */
export function DelimitedTable({ source, delimiter }: { source: string; delimiter: string }) {
  const rows = useMemo(() => parseDelimited(source, delimiter), [source, delimiter]);
  if (rows.length === 0) {
    return <p className="p-6 font-serif text-octo-mute">An empty table.</p>;
  }
  const [head, ...body] = rows;
  const shown = body.slice(0, MAX_TABLE_ROWS);
  const cols = Math.max(head.length, ...shown.map((r) => r.length));
  const cells = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? "");
  return (
    <div className="octo-selectable min-h-0 flex-1 overflow-auto">
      <table className="min-w-full border-collapse font-mono text-[12px]">
        <thead className="sticky top-0 bg-octo-panel">
          <tr>
            <th className="w-10 border-b border-octo-hairline px-2 py-1.5 text-right font-normal text-octo-mute" />
            {cells(head).map((c, i) => (
              <th
                key={i}
                className="whitespace-nowrap border-b border-l border-octo-hairline px-3 py-1.5 text-left font-normal text-octo-brass"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri} className="hover:bg-[var(--brass-ghost)]">
              <td className="border-b border-octo-hairline px-2 py-1 text-right text-octo-mute">{ri + 1}</td>
              {cells(r).map((c, ci) => (
                <td
                  key={ci}
                  className="max-w-[28rem] truncate border-b border-l border-octo-hairline px-3 py-1 text-octo-ivory"
                  title={c}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > shown.length && (
        <p className="px-4 py-3 font-mono text-[11px] text-octo-mute">
          Showing the first {MAX_TABLE_ROWS.toLocaleString()} of {body.length.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}

/** SVG drawn through an <img>: scripts and external fetches inside the file
 *  never run, unlike inlining the markup. */
export function SvgPreview({ source }: { source: string }) {
  const src = useMemo(() => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`, [source]);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
      <img src={src} alt="SVG preview" className="max-h-full max-w-full" />
    </div>
  );
}

/** Prepended to previewed HTML: the sandbox already blocks scripts; this also
 *  stops network fetches (remote images, stylesheets, fonts), so opening an
 *  untrusted file can't phone home. Inline styles and data: URIs still work. */
export const HTML_PREVIEW_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`;

/** `source` with the CSP inserted — after a leading doctype, so the page keeps
 *  standards mode. */
export function withPreviewCsp(source: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
  if (!doctype) return HTML_PREVIEW_CSP + source;
  return doctype[0] + HTML_PREVIEW_CSP + source.slice(doctype[0].length);
}

/** HTML in a fully sandboxed frame: no scripts, no same-origin access, no
 *  network. */
export function HtmlPreview({ source }: { source: string }) {
  return (
    <iframe
      title="HTML preview"
      sandbox=""
      srcDoc={withPreviewCsp(source)}
      className="min-h-0 w-full flex-1 border-0 bg-octo-ivory"
    />
  );
}

/** The rendered form of `kind`, or null when it has none. */
export function QuickViewPreview({ kind, source }: { kind: QuickViewKind; source: string }) {
  switch (kind) {
    case "markdown":
      return <MarkdownPreview source={source} blockRemoteImages />;
    case "csv":
      return <DelimitedTable source={source} delimiter="," />;
    case "tsv":
      return <DelimitedTable source={source} delimiter={"\t"} />;
    case "svg":
      return <SvgPreview source={source} />;
    case "html":
      return <HtmlPreview source={source} />;
    default:
      return null;
  }
}
