import { useState } from "react";
import { GitPullRequest } from "lucide-react";
import { MenuSurface } from "./MenuSurface";
import { ipc } from "../lib/ipc";
import type { PrInfo } from "../lib/types";

interface Props {
  /** Project root — `gh pr list` runs here. */
  projectPath: string;
  /** Called with the chosen PR; the caller owns the side effects
   *  (fetching the head, retargeting the base, prefilling the task). */
  onPick: (pr: PrInfo) => void;
}

/**
 * Quiet icon control for the workspace creator's branch row: a small
 * GitPullRequest button that opens the house menu (MenuSurface chrome)
 * listing the repo's open pull requests via the GitHub CLI.
 *
 * The list is fetched lazily on open. A missing or unauthenticated `gh`
 * degrades to a quiet "GitHub CLI not available" line — starting from a
 * PR is an optional nicety, never a wall.
 */
export function PrPicker({ projectPath, onPick }: Props) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** null = loading. */
  const [prs, setPrs] = useState<PrInfo[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  function open(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuAt({ x: rect.left, y: rect.bottom + 4 });
    setPrs(null);
    setUnavailable(false);
    ipc
      .listPrs(projectPath)
      .then(setPrs)
      .catch(() => {
        setUnavailable(true);
        setPrs([]);
      });
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        title="Start from a pull request"
        onClick={open}
        className="inline-flex items-center rounded-sm text-octo-mute transition-colors duration-[220ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <GitPullRequest size={11} className="shrink-0" />
      </button>
      {menuAt && (
        <MenuSurface
          x={menuAt.x}
          y={menuAt.y}
          ariaLabel="Start from a pull request"
          widthClass="w-[340px]"
          onDismiss={() => setMenuAt(null)}
        >
          {prs === null ? (
            <Quiet>Fetching pull requests…</Quiet>
          ) : unavailable ? (
            <Quiet>GitHub CLI not available</Quiet>
          ) : prs.length === 0 ? (
            <Quiet>No open pull requests</Quiet>
          ) : (
            <div className="max-h-[40vh] overflow-y-auto">
              {prs.map((pr) => (
                <button
                  key={pr.number}
                  type="button"
                  role="menuitem"
                  title={pr.title}
                  onClick={() => {
                    setMenuAt(null);
                    onPick(pr);
                  }}
                  className="flex w-full items-baseline gap-2 px-3 py-2 text-left font-mono text-[11px] transition hover:bg-[var(--brass-ghost)]"
                >
                  <span className="shrink-0 text-[var(--brass-dim)]">#{pr.number}</span>
                  <span className="min-w-0 flex-1 truncate text-octo-ivory">{pr.title}</span>
                  {pr.author && (
                    <span className="shrink-0 text-octo-mute">{pr.author}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </MenuSurface>
      )}
    </>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 font-mono text-[11px] text-octo-mute">{children}</div>
  );
}
