/**
 * PrComposer — "Open a pull request" from Review (ChangesPanel CTA, ⌘K, ⌘⇧P).
 *
 * Preflights the same way "Ship it" does (a GitHub remote + a signed-in `gh`)
 * and dead-ends honestly when either is missing. When ready it drafts a title
 * and body through `ai_complete` from the branch's diff against the base, its
 * commits, the workspace task, the linked ticket and the "How this change was
 * built" provenance — filling the repo's PR template when it has one. The
 * human edits and clicks; nothing is opened on their behalf. Unpublished
 * commits are pushed first, then `gh pr create` runs with the body in a file.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Loader2, Sparkles } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { BranchList, Workspace } from "../lib/types";
import {
  PR_SYSTEM,
  buildPrPrompt,
  diffPaths,
  issueRef,
  parsePrDraft,
  provenanceSummary,
  provenanceTurns,
} from "../lib/prDraft";
import { usePrStore } from "../stores/prStore";
import { ModalShell } from "./ModalShell";
import { BaseBranchPicker } from "./BaseBranchPicker";
import { FadeSwap } from "./primitives/FadeSwap";
import { TogglePill } from "./controls/TogglePill";
import { pushToast } from "./Toasts";

const DRAFT_MODEL = "claude-sonnet-4-6";

type Phase =
  | { kind: "checking" }
  | { kind: "no-remote" }
  | { kind: "no-auth" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

interface Props {
  workspace: Workspace;
  workspacePath: string;
  onClose: () => void;
}

export function PrComposer({ workspace, workspacePath, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [branches, setBranches] = useState<BranchList>({ local: [], remote: [] });
  const [branch, setBranch] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftNote, setDraftNote] = useState<{ tone: "mute" | "rouge"; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [unpushed, setUnpushed] = useState(false);
  const draftGen = useRef(0);

  const runDraft = useCallback(
    async (onto: string) => {
      const gen = ++draftGen.current;
      setDrafting(true);
      setDraftNote(null);
      try {
        const ctx = await ipc.prDraftContext(workspacePath, onto);
        if (gen !== draftGen.current) return;
        setBranch(ctx.branch);
        if (!ctx.diff.trim() && ctx.commits.length === 0) {
          setDraftNote({ tone: "rouge", text: `This branch has no changes against ${onto} yet.` });
          return;
        }
        const edits = await ipc.listFileEdits(workspace.id).catch(() => []);
        const turns = provenanceTurns(edits, diffPaths(ctx.diff));
        const withModels = await Promise.all(
          turns.map(async (t, i) => ({
            ...t,
            model: i < 12 ? ((await ipc.getMessage(t.messageId).catch(() => null))?.model ?? null) : null,
          })),
        );
        const r = await ipc.aiComplete(
          DRAFT_MODEL,
          PR_SYSTEM,
          buildPrPrompt({
            diff: ctx.diff,
            commits: ctx.commits,
            template: ctx.template,
            task: workspace.task,
            issueKey: workspace.linkedIssueKey,
            provenance: provenanceSummary(withModels),
          }),
          { workspaceId: workspace.id },
        );
        if (gen !== draftGen.current) return;
        const parsed = parsePrDraft(r.text, workspace.linkedIssueKey);
        setTitle(parsed.title);
        setBody(parsed.body);
        // Never `$0` and never a missing figure: an unknown cost says so.
        const cost =
          typeof r.costUsd === "number" && r.costUsd > 0
            ? ` · $${r.costUsd.toFixed(r.costUsd < 0.01 ? 4 : 2)}`
            : " · unpriced";
        setDraftNote({
          tone: "mute",
          text: `Drafted by ${DRAFT_MODEL}${ctx.template ? " from the repo's template" : ""}${cost}`,
        });
      } catch (e) {
        if (gen !== draftGen.current) return;
        setDraftNote({ tone: "rouge", text: `Couldn't draft: ${String(e).split("\n")[0]}` });
      } finally {
        if (gen === draftGen.current) setDrafting(false);
      }
    },
    [workspacePath, workspace.id, workspace.task, workspace.linkedIssueKey],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const readiness = await ipc.githubShipReadiness(workspacePath);
        if (cancelled) return;
        if (!readiness.githubRemote) return setPhase({ kind: "no-remote" });
        if (!readiness.ghAuthenticated) return setPhase({ kind: "no-auth" });
        const [list, status] = await Promise.all([
          ipc.listBranches(workspacePath).catch(() => ({ local: [], remote: [] })),
          ipc.getGitStatus(workspacePath).catch(() => null),
        ]);
        if (cancelled) return;
        const onto = workspace.fromBranch || list.local[0] || "main";
        setBranches(list);
        setBase(onto);
        setUnpushed(!!status && (!status.hasUpstream || status.ahead > 0));
        // A Jira-style key seeds the title before any draft arrives.
        const prefix = issueRef(workspace.linkedIssueKey).titlePrefix;
        setTitle(prefix ? `${prefix}: ${workspace.task}` : workspace.task);
        setPhase({ kind: "ready" });
        void runDraft(onto);
      } catch (e) {
        if (!cancelled) setPhase({ kind: "error", message: String(e).split("\n")[0] });
      }
    })();
    return () => {
      cancelled = true;
      draftGen.current++;
    };
    // Preflight once per open; the draft re-runs only on request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  async function handleCreate() {
    if (!base || !title.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const status = await ipc.getGitStatus(workspacePath);
      if (!status.hasUpstream || status.ahead > 0) await ipc.pushBranch(workspacePath);
      const pr = await ipc.createPullRequest(workspacePath, base, title.trim(), body, draft);
      usePrStore.getState().setPr(workspace.id, pr);
      pushToast({
        level: "success",
        title: `Pull request #${pr.number} opened`,
        body: pr.title,
        action: { label: "View on GitHub", onClick: () => void ipc.openFileInSystem(pr.url) },
      });
      onClose();
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }

  const canCreate = phase.kind === "ready" && !!base && title.trim().length > 0 && !creating && !drafting;

  return (
    <ModalShell onClose={onClose} closeOnBackdrop={false} ariaLabel="Open a pull request" panelClassName="w-full max-w-[680px]">
      <div className="flex max-h-[84vh] flex-col overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl">
        <header className="border-b border-octo-hairline px-5 pt-4 pb-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">Review · pull request</span>
          <h2 className="mt-1 font-serif text-[17px] leading-tight text-octo-ivory">Open a pull request</h2>
          {phase.kind === "ready" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-octo-mute">
              <span title="Branch" className="flex items-center">
                <GitBranch size={10} aria-hidden />
              </span>
              <span className="max-w-[28ch] truncate text-octo-sage" title={branch ?? undefined}>
                {branch ?? workspace.branch}
              </span>
              <span>into</span>
              <BaseBranchPicker
                branches={branches.local}
                remoteBranches={branches.remote}
                value={base}
                onSelect={setBase}
              />
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <FadeSwap swapKey={phase.kind}>
            {phase.kind === "checking" && (
              <div className="flex items-center gap-2 py-6 text-[12px] text-octo-sage">
                <Loader2 size={12} className="animate-spin text-octo-sage" />
                Checking GitHub…
              </div>
            )}
            {phase.kind === "no-remote" && (
              <p className="py-6 text-center text-[13px] text-octo-sage">
                This project has no GitHub remote — there is nowhere to open the pull request.
              </p>
            )}
            {phase.kind === "no-auth" && (
              <div className="py-6 text-center">
                <p className="text-[13px] text-octo-sage">
                  The GitHub CLI isn't installed or signed in — it opens the pull request.
                </p>
                <p className="mt-2 font-mono text-[11px] text-octo-mute">
                  Run <span className="text-octo-ivory">gh auth login</span> in a terminal, then try again.
                </p>
              </div>
            )}
            {phase.kind === "error" && (
              <p className="py-6 text-center font-mono text-[11px] text-octo-mute">{phase.message}</p>
            )}
            {phase.kind === "ready" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={drafting || creating}
                    placeholder="Name the change…"
                    aria-label="Pull request title"
                    className="min-w-0 flex-1 rounded-md border border-octo-border-strong bg-octo-onyx px-2.5 py-1.5 text-[13px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => base && void runDraft(base)}
                    disabled={!base || drafting || creating}
                    title="Draft the title and description again from the diff"
                    aria-label="Draft again"
                    className="shrink-0 rounded border border-octo-border-strong p-1.5 text-octo-sage transition-colors hover:text-octo-ivory disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    {drafting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  </button>
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={drafting || creating}
                  rows={14}
                  placeholder={drafting ? "Drafting from the diff…" : "Describe the change…"}
                  aria-label="Pull request description"
                  className="w-full resize-y rounded-md border border-octo-border-strong bg-octo-onyx p-2.5 font-mono text-[12px] leading-[1.55] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute focus-visible:ring-1 focus-visible:ring-octo-brass disabled:opacity-50"
                />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <TogglePill
                    on={draft}
                    onChange={(on) => !creating && setDraft(on)}
                    label="Draft"
                    ariaLabel="Open as a draft"
                  />
                  {unpushed && (
                    <span className="font-mono text-[10px] text-octo-mute">Unpublished commits are pushed first.</span>
                  )}
                </div>
                {draftNote && (
                  <p
                    className={`octo-rise-in font-mono text-[10px] ${draftNote.tone === "rouge" ? "text-octo-rouge" : "text-octo-mute"}`}
                  >
                    {draftNote.text}
                  </p>
                )}
                {createError && (
                  <p role="alert" className="octo-rise-in text-[12px] leading-relaxed text-octo-rouge">
                    {createError}
                  </p>
                )}
              </div>
            )}
          </FadeSwap>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-octo-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition-colors hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            Cancel
          </button>
          {phase.kind === "ready" && (
            <button
              type="button"
              data-tour="pr-composer-create"
              onClick={handleCreate}
              disabled={!canCreate}
              className="flex items-center gap-1.5 rounded-md px-3 py-1 font-serif text-[13px] text-octo-brass transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{ border: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }}
            >
              {creating && <Loader2 size={12} className="animate-spin" />}
              {draft ? "Open the draft pull request" : "Open the pull request"}
            </button>
          )}
        </footer>
      </div>
    </ModalShell>
  );
}
