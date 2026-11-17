/**
 * SecretGuardDialog — the secret guard's confirm (#730). Shown when a commit,
 * push or pull request is refused with `SecretsFound`. Lists what was found
 * (kind · file:line — never the value). "Leave it out" is the default focus
 * and Escape's action; the override is an explicit second choice that applies
 * to this one action only.
 */
import { ShieldAlert } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { findingLocation, guardHeadline, overrideLabel, type GuardedAction, type SecretFinding } from "../lib/secretGuard";

const SHOWN = 5;

interface Props {
  action: GuardedAction;
  findings: SecretFinding[];
  /** Close without acting; the caller may focus the first finding's file. */
  onLeaveOut: () => void;
  /** The explicit "regardless" for this one action. */
  onOverride: () => void;
}

export function SecretGuardDialog({ action, findings, onLeaveOut, onOverride }: Props) {
  const shown = findings.slice(0, SHOWN);
  const more = findings.length - shown.length;
  const yours = findings.some((f) => f.yours);
  return (
    <ModalShell onClose={onLeaveOut} closeOnBackdrop={false} ariaLabel="Possible secret" panelClassName="w-full max-w-[460px]">
      <div data-tour="secret-guard-dialog" className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-rouge">
          <ShieldAlert size={12} strokeWidth={1.75} aria-hidden />
          <span>Possible secret</span>
        </div>
        <h2 className="mt-2 font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory">
          {guardHeadline(action, findings)}
        </h2>
        {findings.length > 1 && (
          <ul className="mt-3 space-y-1" aria-label="What was found">
            {shown.map((f) => (
              <li key={`${f.file}:${f.line ?? 0}:${f.rule}`} className="flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-octo-sage">{f.kind}</span>
                <span className="min-w-0 truncate text-octo-mute" title={findingLocation(f)}>
                  {findingLocation(f)}
                </span>
              </li>
            ))}
            {more > 0 && <li className="font-mono text-[11px] text-octo-mute">and {more} more</li>}
          </ul>
        )}
        <p className="mt-3 text-[12px] leading-relaxed text-octo-sage">
          {yours ? "It matches a key you saved in Octopush. " : ""}
          Take it out of the change, or confirm for this one {action === "pr" ? "pull request" : action}. Octopush never shows or stores the value.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onOverride}
            className="rounded-md border border-[color:var(--rouge-border)] px-4 py-2 font-mono text-[11px] text-octo-rouge transition-colors duration-[180ms] hover:bg-[var(--rouge-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-rouge"
          >
            {overrideLabel(action)}
          </button>
          <button
            type="button"
            autoFocus
            onClick={onLeaveOut}
            className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            Leave it out
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
