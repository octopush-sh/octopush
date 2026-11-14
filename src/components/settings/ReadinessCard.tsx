// Settings › General — "Is this Mac ready for a crew?". One row per local
// check, run when the pane opens and on "Check again". The result slot always
// answers: not checked yet, checking, the rows, or that no checks came back.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle, Circle, Clock, Copy, Loader2, XCircle } from "lucide-react";
import type { ReadinessCheck } from "../../lib/ipc";
import { copyToClipboard } from "../../lib/clipboard";
import { useReadinessStore } from "../../stores/readinessStore";
import { usePipelineStore } from "../../stores/pipelineStore";
import { useRoutinesStore } from "../../stores/routinesStore";
import { useModelRetirements } from "../../hooks/useModelRetirements";
import { libraryModels, readinessRetirementCheck } from "../../lib/modelRetirement";
import { tourId } from "../../lib/tour/ids";
import { SectionLabel, formatRelative } from "./shared";

type StatusStyle = { word: string; tone: string; Icon: typeof CheckCircle };

const STATUS: Record<ReadinessCheck["status"], StatusStyle> = {
  ok: { word: "Ready", tone: "text-octo-verdigris", Icon: CheckCircle },
  warn: { word: "Warning", tone: "text-octo-warning", Icon: AlertTriangle },
  fail: { word: "Failed", tone: "text-octo-rouge", Icon: XCircle },
};

/** A status this build doesn't know (an older or newer backend): mute, never a verdict. */
const PENDING: StatusStyle = { word: "Unknown", tone: "text-octo-mute", Icon: Circle };

/** The rows a tour can point at. */
const ROW_TOUR: Partial<Record<ReadinessCheck["id"], string>> = {
  disk: tourId("settings-readiness-disk"),
  codex: tourId("settings-readiness-codex"),
  models: tourId("settings-readiness-models"),
};

/** `onShowCaches` closes Settings and opens the footer's Workspace Caches;
 *  the disk row links to it when space runs low. */
export function ReadinessCard({ onShowCaches }: { onShowCaches?: () => void } = {}) {
  const checks = useReadinessStore((s) => s.checks);
  const checkedAt = useReadinessStore((s) => s.checkedAt);
  const loading = useReadinessStore((s) => s.loading);
  const error = useReadinessStore((s) => s.error);
  const check = useReadinessStore((s) => s.check);

  // Once per pane open.
  useEffect(() => {
    void check();
  }, [check]);

  // Keep "Checked 2m ago" honest while the pane stays open.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (checkedAt === null) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [checkedAt]);

  // Saved crews and Routines on a model that retires: a row of its own,
  // built here from the library (the backend only knows the table).
  const pipelines = usePipelineStore((s) => s.pipelines);
  const pipelinesLoaded = usePipelineStore((s) => s.loaded);
  const loadPipelines = usePipelineStore((s) => s.load);
  const routines = useRoutinesStore((s) => s.routines);
  const routinesLoaded = useRoutinesStore((s) => s.loaded);
  const loadRoutines = useRoutinesStore((s) => s.load);
  useEffect(() => {
    if (!pipelinesLoaded) void loadPipelines();
    if (!routinesLoaded) void loadRoutines();
  }, [pipelinesLoaded, loadPipelines, routinesLoaded, loadRoutines]);
  const retirements = useModelRetirements(libraryModels(pipelines, routines));
  const modelsRow = readinessRetirementCheck(pipelines, routines, retirements, new Date());
  const rows = checks && checks.length > 0 && modelsRow ? [...checks, modelsRow] : checks;

  const neverChecked = !checks && !loading && !error;

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
            onClick={() => void check({ explicit: true })}
            disabled={loading}
            className="shrink-0 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi disabled:opacity-50"
          >
            {loading ? "Checking…" : neverChecked ? "Run the check" : "Check again"}
          </button>
        </div>

        {error && <p className="octo-pop-in mt-3 text-[12px] text-octo-rouge">Couldn't run the checks: {error}</p>}

        {neverChecked && (
          <p data-testid="readiness-unchecked" className="octo-fade-in mt-3 text-[12px] text-octo-mute">
            Not checked yet.
          </p>
        )}

        {!checks && loading && (
          <div data-testid="readiness-loading" className="octo-fade-in mt-3 flex items-center gap-2 text-[12px] text-octo-mute">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            Checking this Mac…
          </div>
        )}

        {checks && checks.length === 0 && (
          <p data-testid="readiness-empty" className="octo-fade-in mt-3 text-[12px] text-octo-mute">
            No checks came back from this Mac. Check again, or update Octopush if it keeps happening.
          </p>
        )}

        {rows && rows.length > 0 && (
          <ul className="mt-3 divide-y divide-octo-hairline">
            {rows.map((c, i) => (
              <ReadinessRow key={c.id ?? i} check={c} index={i} onShowCaches={c.id === "disk" ? onShowCaches : undefined} />
            ))}
          </ul>
        )}

        {checks && checkedAt !== null && (
          <div
            data-tour="settings-readiness-checked"
            data-testid="readiness-checked"
            className="octo-fade-in mt-2 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute"
            title={new Date(checkedAt).toLocaleString()}
          >
            Checked {formatRelative(checkedAt)}
          </div>
        )}
      </div>
    </div>
  );
}

function ReadinessRow({ check, index, onShowCaches }: { check: ReadinessCheck; index: number; onShowCaches?: () => void }) {
  const [copied, setCopied] = useState(false);
  const { word, tone, Icon: StatusIcon } = STATUS[check.status] ?? PENDING;
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
      data-tour={ROW_TOUR[check.id]}
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
          {onShowCaches && (
            <button
              type="button"
              onClick={onShowCaches}
              className="mt-1 font-serif text-[12px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory"
            >
              See what this workspace caches
            </button>
          )}
        </div>
      )}
    </li>
  );
}
