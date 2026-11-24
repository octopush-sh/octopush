/**
 * SecretGuardDialog — the secret guard's confirm (#730). Shown when a commit,
 * push or pull request is refused with `SecretsFound`. Lists what was found
 * (kind · file:line · masked preview like `sk-ant-…9fQ2` — never the value,
 * #820), and says so when the scan stopped
 * at its 16 MB budget. "Leave it out" is the default focus and Escape's
 * action; the override is an explicit second choice that applies to this one
 * action and these exact findings only (the core rescans and checks the
 * fingerprint).
 */
import { ShieldAlert } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { PARTIAL_NOTE, PREVIEW_TIP, findingLocation, guardHeadline, overrideLabel, type GuardedAction, type SecretRefusal } from "../lib/secretGuard";

const SHOWN = 5;

interface Props {
  action: GuardedAction;
  /** What the guard refused; the override confirms exactly this. */
  refusal: SecretRefusal;
  /** Close without acting; the caller may focus the first finding's file. */
  onLeaveOut: () => void;
  /** The explicit "regardless" for this one action. */
  onOverride: () => void;
}

export function SecretGuardDialog({ action, refusal, onLeaveOut, onOverride }: Props) {
  const { findings, total, partial } = refusal;
  const shown = findings.slice(0, SHOWN);
  const more = Math.max(total, findings.length) - shown.length;
  const yours = findings.some((f) => f.yours);
  return (
    <ModalShell onClose={onLeaveOut} closeOnBackdrop={false} ariaLabel="Possible secret" panelClassName="w-full max-w-[460px]">
      <div data-tour="secret-guard-dialog" className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-rouge">
          <ShieldAlert size={12} strokeWidth={1.75} aria-hidden />
          <span>Possible secret</span>
        </div>
        <h2 className="mt-2 font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory">
          {guardHeadline(action, findings, total)}
        </h2>
        {findings.length > 1 || total > findings.length ? (
          <ul className="mt-3 space-y-1" aria-label="What was found">
            {shown.map((f, i) => (
              <li key={`${f.file}:${f.line ?? 0}:${f.rule}:${i}`} className="flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-octo-sage">{f.kind}</span>
                <span className="min-w-0 truncate text-octo-mute" title={findingLocation(f)}>
                  {findingLocation(f)}
                </span>
                {f.preview && (
                  <span className="ml-auto shrink-0 text-octo-mute" title={PREVIEW_TIP}>
                    {f.preview}
                  </span>
                )}
              </li>
            ))}
            {more > 0 && <li className="font-mono text-[11px] text-octo-mute">and {more} more</li>}
          </ul>
        ) : (
          findings[0]?.preview && (
            <p data-tour="secret-guard-preview" className="mt-2 font-mono text-[11px] text-octo-mute" title={PREVIEW_TIP}>
              {findings[0].preview}
            </p>
          )
        )}
        {partial && (
          <p data-tour="secret-guard-partial" className="mt-3 font-mono text-[11px] text-octo-mute">
            {PARTIAL_NOTE}
          </p>
        )}
        <p className="mt-3 text-[12px] leading-relaxed text-octo-sage">
          {yours ? "It matches a key you saved in Octopush. " : ""}
          {action === "message"
            ? "Leave it out and the rest of the message is sent without it, or confirm for this one message."
            : `${total > 0 ? "Take it out of the change, or confirm" : "Confirm"} for this one ${action === "pr" ? "pull request" : action}.`}{" "}
          Octopush shows only a provider's prefix and the last four characters, and never stores the value.
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
