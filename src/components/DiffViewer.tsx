/**
 * DiffViewer — read-only diff renderer for the Direct mode canvas.
 *
 * Takes a raw git diff string and renders files → hunks → ±/context lines.
 * No accept/reject/why buttons. No IPC calls. Pure display.
 */

import { useMemo } from "react";
import { parseFullDiff } from "../lib/diffParser";
import { diffLineStyle } from "../lib/diffLineStyle";

interface Props {
  diff: string;
}

export function DiffViewer({ diff }: Props) {
  const files = useMemo(() => parseFullDiff(diff), [diff]);

  if (!diff.trim() || files.length === 0) {
    return (
      <div className="p-4 font-mono text-xs text-octo-mute">
        No changes in the worktree yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 octo-fade-in">
      {files.map((file) => (
        <div
          key={file.filePath}
          className="overflow-hidden rounded-lg border border-octo-hairline"
        >
          {/* File header */}
          <div className="border-b border-octo-hairline bg-octo-panel-2 px-3 py-1.5 font-mono text-[11px] text-octo-ivory">
            {file.filePath}
          </div>

          {/* Hunks */}
          <div className="overflow-x-auto font-mono text-[11px] leading-relaxed">
            {file.hunks.map((hunk, hunkIdx) => {
              // hunk.lines[0] is the @@ header line; body lines follow.
              const bodyLines =
                hunk.lines.length > 0 && hunk.lines[0].startsWith("@@")
                  ? hunk.lines.slice(1)
                  : hunk.lines;

              return (
                <div key={hunkIdx}>
                  {/* Hunk header row */}
                  <div className="border-b border-octo-hairline bg-octo-onyx/40 px-3 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-octo-mute">
                    {hunk.header}
                    {(hunk.additions > 0 || hunk.deletions > 0) && (
                      <span className="ml-3 normal-case tracking-normal">
                        {hunk.additions > 0 && (
                          <span className="text-octo-verdigris mr-2">
                            +{hunk.additions}
                          </span>
                        )}
                        {hunk.deletions > 0 && (
                          <span className="text-octo-rouge">
                            −{hunk.deletions}
                          </span>
                        )}
                      </span>
                    )}
                  </div>

                  {/* Diff lines */}
                  <pre className="px-0 font-mono text-[11.5px] leading-[1.55]">
                    {bodyLines.map((line, lineIdx) => {
                      const { className, background } = diffLineStyle(line);
                      return (
                        <div
                          key={lineIdx}
                          className={`whitespace-pre px-3 ${className}`}
                          style={background ? { background } : undefined}
                        >
                          {line}
                        </div>
                      );
                    })}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
