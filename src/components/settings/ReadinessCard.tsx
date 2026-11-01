// Settings › General — "Is this Mac ready for a crew?". One row per local
// check (claude + version vs the tested floor, auth mode, git, gh, Ollama
// when its provider is on), run once when the pane opens and on "Check
// again". A failing row carries a one-line fix and a copyable command.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Clock, Copy, Loader2, XCircle } from "lucide-react";
import type { ReadinessCheck } from "../../lib/ipc";
import { copyToClipboard } from "../../lib/clipboard";
import { useReadinessStore } from "../../stores/readinessStore";
import { SectionLabel } from "./shared";

const STATUS: Record<ReadinessCheck["status"], { word: string; tone: string; Icon: typeof CheckCircle }> = {
  ok: { word: "Ready", tone: "text-octo-verdigris", Icon: CheckCircle },
  warn: { word: "Warning", tone: "text-octo-warning", Icon: AlertTriangle },
  fail: { word: "Failed", tone: "text-octo-rouge", Icon: XCircle },
};

export function ReadinessCard() {
  const checks = useReadinessStore((s) => s.checks);
  const loading = useReadinessStore((s) => s.loading);
  const error = useReadinessStore((s) => s.error);
  const check = useReadinessStore((s) => s.check);

  // Once per pane open.
  useEffect(() => {
    void check();
  }, [check]);

  return (
    <div className="space-y-4">
      <SectionLabel>Readiness</SectionLabel>
      <div
        data-tour="settings-readiness-card"
        data-testid="readiness-card"
        className="rounded-lg px-4 py-3"
        style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="font-serif text-[14px] leading-tight text-octo-ivory">Is this Mac ready for a crew?</div>
            <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
              The things a crew needs in its first minute, checked with local commands, each given 3 seconds.
            </div>
          </div>
          <button
            type="button"
            data-tour="settings-readiness-again"
            onClick={() => void check()}
            disabled={loading}
            className="shrink-0 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi disabled:opacity-50"
          >
            {loading ? "Checking…" : "Check again"}
          </button>
        </div>

        {error && <p className="octo-pop-in mt-3 text-[12px] text-octo-rouge">Couldn't run the checks: {error}</p>}

        {!checks && loading && (
          <div data-testid="readiness-loading" className="octo-fade-in mt-3 flex items-center gap-2 text-[12px] text-octo-mute">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            Checking this Mac…
          </div>
        )}

        {checks && (
          <ul className="mt-3 divide-y divide-octo-hairline">
            {checks.map((c, i) => (
              <ReadinessRow key={c.id} check={c} index={i} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ReadinessRow({ check, index }: { check: ReadinessCheck; index: number }) {
  const [copied, setCopied] = useState(false);
  const { word, tone, Icon: StatusIcon } = STATUS[check.status];
  const Icon = check.timedOut ? Clock : StatusIcon;
  const statusWord = check.timedOut ? "Timed out" : word;

  async function copy(command: string) {
    if (await copyToClipboard(command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <li
      data-testid={`readiness-row-${check.id}`}
      data-status={check.status}
      className="octo-rise-in py-2.5"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="flex items-center gap-3">
        <span className={`shrink-0 ${tone}`} title={`${check.label}: ${statusWord}`}>
          <Icon size={13} strokeWidth={1.75} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-octo-ivory">{check.label}</span>
        <span className="octo-tabular truncate font-mono text-[11px] text-octo-sage">{check.value}</span>
        <span className={`w-[64px] shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.15em] ${tone}`}>
          {statusWord}
        </span>
      </div>
      {check.status !== "ok" && check.fix && (
        <div className="mt-1.5 pl-[25px]">
          <p className="text-[12px] leading-[1.55] text-octo-sage">{check.fix}</p>
          {check.command && (
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 truncate rounded bg-octo-onyx px-2 py-1 font-mono text-[11px] text-octo-ivory">
                {check.command}
              </code>
              <button
                type="button"
                onClick={() => void copy(check.command!)}
                title={copied ? "Copied" : "Copy command"}
                aria-label={`Copy ${check.command}`}
                className="shrink-0 rounded p-1 text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory"
              >
                <Copy size={12} aria-hidden />
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
