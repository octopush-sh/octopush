import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { GhIssue } from "../lib/types";
import { ModalShell } from "./ModalShell";

/** Pick an open GitHub issue for the "Ship it" flow. Preflights readiness
 *  FIRST — the crew's `pull_request` stage needs a github.com origin and an
 *  authenticated `gh`, and discovering that mid-run (after the crew already
 *  built the change) is the failure mode this modal exists to prevent. Every
 *  issue value renders as inert text. */
export function GithubIssuePicker({
  workspacePath,
  onPick,
  onClose,
}: {
  workspacePath: string;
  onPick: (issue: GhIssue) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "no-remote" }
    | { kind: "no-auth" }
    | { kind: "error"; message: string }
    | { kind: "ready"; issues: GhIssue[] }
  >({ kind: "loading" });
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const readiness = await ipc.githubShipReadiness(workspacePath);
        if (cancelled) return;
        if (!readiness.githubRemote) {
          setState({ kind: "no-remote" });
          return;
        }
        if (!readiness.ghAuthenticated) {
          setState({ kind: "no-auth" });
          return;
        }
        const issues = await ipc.listGithubIssues(workspacePath);
        if (!cancelled) setState({ kind: "ready", issues });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e).split("\n")[0] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const filtered = useMemo(() => {
    if (state.kind !== "ready") return [];
    // "#42" must match — the rows themselves display the number that way.
    const q = filter.trim().toLowerCase().replace(/^#/, "");
    if (!q) return state.issues;
    return state.issues.filter(
      (i) => i.title.toLowerCase().includes(q) || String(i.number).includes(q),
    );
  }, [state, filter]);

  return (
    <ModalShell onClose={onClose} ariaLabel="Ship a GitHub issue" panelClassName="w-full max-w-[560px]">
      <div className="flex max-h-[64vh] flex-col overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl">
        <div className="border-b border-octo-hairline px-5 pt-4 pb-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
            Direct · ship an issue
          </span>
          <h2 className="mt-1 font-serif text-[17px] leading-tight text-octo-ivory">
            Pick an issue — the crew takes it from here.
          </h2>
        </div>

        {state.kind === "loading" && (
          <p className="px-5 py-10 text-center text-[13px] text-octo-sage">Reading open issues…</p>
        )}

        {state.kind === "no-remote" && (
          <p className="px-5 py-10 text-center text-[13px] text-octo-sage">
            This project has no GitHub remote — the crew would have nowhere to open the pull request.
          </p>
        )}

        {state.kind === "no-auth" && (
          <div className="px-5 py-10 text-center">
            <p className="text-[13px] text-octo-sage">
              The GitHub CLI isn't signed in — the crew needs it to open the pull request.
            </p>
            <p className="mt-2 font-mono text-[11px] text-octo-mute">
              Run <span className="text-octo-ivory">gh auth login</span> in a terminal, then try again.
            </p>
          </div>
        )}

        {state.kind === "error" && (
          <p className="px-5 py-10 text-center font-mono text-[11px] text-octo-mute">{state.message}</p>
        )}

        {state.kind === "ready" && (
          <>
            <div className="flex items-center gap-2 border-b border-octo-hairline px-5 py-2">
              <Search size={12} className="shrink-0 text-octo-mute" aria-hidden />
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by title or number"
                aria-label="Filter issues"
                className="w-full bg-transparent font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-5 py-10 text-center text-[13px] text-octo-mute">
                  {state.issues.length === 0 ? "No open issues." : "Nothing matches."}
                </p>
              ) : (
                <ul>
                  {filtered.map((issue) => (
                    <li key={issue.number} className="border-b border-octo-hairline/60 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => onPick(issue)}
                        title="Put the crew on this issue"
                        className="block w-full px-5 py-2.5 text-left transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] focus-visible:bg-[var(--brass-ghost)] focus-visible:outline-none"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="octo-tabular shrink-0 font-mono text-[11px] text-octo-brass">
                            #{issue.number}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-octo-ivory">
                            {issue.title}
                          </span>
                        </div>
                        {issue.body.trim() && (
                          <p className="mt-0.5 truncate pl-6 font-mono text-[10px] text-octo-mute">
                            {issue.body.split("\n")[0].slice(0, 120)}
                          </p>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}
