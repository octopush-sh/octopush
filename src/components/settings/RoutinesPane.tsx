// Settings → Routines — scheduled crews (Pro). A saved pipeline fires on a
// schedule and drives itself via the detached worker: "every morning there's a
// finished PR waiting." CRUD only; live status lives in Mission Control.
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Pencil, Play, Plus, Power, Trash2 } from "lucide-react";
import { PaneHeader, SectionLabel } from "./shared";
import { ModalShell } from "../ModalShell";
import { Listbox } from "../controls/Listbox";
import { useRoutinesStore } from "../../stores/routinesStore";
import { useProjectStore } from "../../stores/projectStore";
import { usePipelineStore } from "../../stores/pipelineStore";
import { useEntitlementStore } from "../../stores/entitlementStore";
import { ipc, type Routine } from "../../lib/ipc";
import type { Workspace } from "../../lib/types";
import { pushToast } from "../Toasts";
import { formatRelTime } from "../../lib/relTime";
import {
  draftFromRoutine,
  draftToInput,
  recurringSpecOf,
  scheduleSummary,
  to12h,
  untilLabel,
  type RoutineDraft,
} from "../../lib/routineForm";

const ROUTINES_FEATURE = "routines.scheduled";

// Listbox trigger surface that matches this form's TextInput/time/number fields
// (same border/bg/focus tokens) so the pickers read as siblings, in both themes.
const FIELD_SURFACE =
  "border border-octo-hairline bg-octo-bg text-octo-ivory hover:border-[var(--brass-dim)] focus:border-octo-brass";

/** The last evaluation, legible in the list row ("dispatched · 5m ago" /
 *  "condition not met · 2m ago") so a routine that keeps skipping doesn't look
 *  dead. Null when the routine has never been evaluated. */
function lastCheckLabel(r: Routine): string | null {
  if (!r.lastCheckedAt || !r.lastOutcome) return null;
  const rel = formatRelTime(new Date(r.lastCheckedAt).getTime());
  return `${r.lastOutcome} · ${rel}`;
}

export function RoutinesPane() {
  const hasFeature = useEntitlementStore((s) => s.hasFeature);
  const entitled = hasFeature(ROUTINES_FEATURE);
  const routines = useRoutinesStore((s) => s.routines);
  const load = useRoutinesStore((s) => s.load);
  const setEnabled = useRoutinesStore((s) => s.setEnabled);
  const remove = useRoutinesStore((s) => s.remove);
  const runNow = useRoutinesStore((s) => s.runNow);
  const runningNow = useRoutinesStore((s) => s.runningNow);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);

  const recent = useProjectStore((s) => s.recent);
  const loadRecent = useProjectStore((s) => s.loadRecent);
  const pipelines = usePipelineStore((s) => s.pipelines);
  const loadPipelines = usePipelineStore((s) => s.load);

  useEffect(() => {
    void load();
    void loadRecent();
    void loadPipelines();
  }, [load, loadRecent, loadPipelines]);

  const projectName = useMemo(() => {
    const m = new Map(recent.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? "unknown project";
  }, [recent]);

  const openUpgrade = async () => {
    try {
      const url = await ipc.billingCheckoutUrl();
      await ipc.openFileInSystem(url);
    } catch {
      pushToast({ level: "error", title: "Couldn't open checkout" });
    }
  };

  return (
    <>
      <PaneHeader
        eyebrow="Routines"
        title="Crews that clock in on their own."
        subtitle="Put a pipeline on a schedule — a review each morning, a dependency sweep every few hours. Routines fire while Octopush is running (a window missed while it was closed catches up on next launch); once a run starts it's detached, so the crew keeps going even if you quit."
      />

      <div className="max-w-[720px] space-y-6">
        {/* Upgrade banner (not a full replacement): a user who made routines
            while Pro then downgraded must still see and manage them. */}
        {!entitled && (
          <div className="flex items-center gap-4 rounded-xl border border-octo-hairline bg-octo-panel px-5 py-4">
            <CalendarClock size={20} className="shrink-0 text-octo-brass" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="font-serif text-[14px] text-octo-ivory">Scheduled crews are a Pro craft.</p>
              <p className="mt-0.5 text-[12px] leading-snug text-octo-sage">
                {routines.length > 0
                  ? "Your routines are paused until you upgrade — you can still manage them below."
                  : "Upgrade to let saved pipelines run themselves on a cadence you set."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void openUpgrade()}
              className="shrink-0 rounded-md border border-octo-brass px-4 py-1.5 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]"
            >
              Upgrade to Pro
            </button>
          </div>
        )}

        {(entitled || routines.length > 0) && (
          <>
            <div className="flex items-center justify-between">
              <SectionLabel>Your routines</SectionLabel>
              {entitled && (
                <button
                  type="button"
                  onClick={() => setEditing("new")}
                  className="flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-serif text-[13px] text-octo-ivory transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]"
                >
                  <Plus size={13} className="text-octo-brass" aria-hidden />
                  Compose a routine
                </button>
              )}
            </div>

            {routines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-octo-hairline px-6 py-10 text-center text-[13px] text-octo-mute">
                No routines yet — compose one to put a pipeline on a schedule.
              </p>
            ) : (
              <ul className="space-y-2">
                {routines.map((r) => (
                  <li
                    key={r.id}
                    className="octo-rise-in flex items-center gap-3 rounded-lg border border-octo-hairline bg-octo-panel px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate font-serif text-[15px] text-octo-ivory">{r.name}</span>
                        {!r.enabled && (
                          <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                            paused
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-octo-sage">
                        <span className="text-octo-brass">{scheduleSummary(r.scheduleKind, r.scheduleSpec)}</span>
                        <span>· {projectName(r.projectId)}</span>
                        <span>· {r.workspaceMode === "fresh" ? "fresh workspace" : "fixed workspace"}</span>
                        {r.fireCondition && <span title="This routine fires only when its condition command exits 0.">· conditional</span>}
                        {r.enabled && entitled && <span>· next {untilLabel(r.nextDueAt)}</span>}
                      </div>
                      {lastCheckLabel(r) && (
                        <div className="mt-0.5 font-mono text-[10px] text-octo-mute">{lastCheckLabel(r)}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Run-now and enable need entitlement; pause and delete
                          are always available so a downgraded user can clean up. */}
                      {entitled && (
                        <>
                          <IconButton
                            title={runningNow.includes(r.id) ? "Running…" : "Run now"}
                            onClick={() => void runNow(r.id)}
                            disabled={runningNow.includes(r.id)}
                          >
                            {runningNow.includes(r.id) ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <Play size={13} />
                            )}
                          </IconButton>
                          <IconButton
                            title={r.enabled ? "Pause this routine" : "Resume this routine"}
                            onClick={() => void setEnabled(r.id, !r.enabled)}
                            active={r.enabled}
                          >
                            <Power size={13} />
                          </IconButton>
                          <IconButton title="Edit" onClick={() => setEditing(r)}>
                            <Pencil size={13} />
                          </IconButton>
                        </>
                      )}
                      {!entitled && r.enabled && (
                        <IconButton title="Pause this routine" onClick={() => void setEnabled(r.id, false)} active>
                          <Power size={13} />
                        </IconButton>
                      )}
                      <IconButton title="Delete" onClick={() => void remove(r.id)} danger>
                        <Trash2 size={13} />
                      </IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {editing && (
        <RoutineEditor
          routine={editing === "new" ? null : editing}
          projects={recent}
          pipelines={pipelines.map((p) => ({ id: p.pipeline.id, name: p.pipeline.name }))}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function IconButton({
  title,
  onClick,
  children,
  active,
  danger,
  disabled,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const tone = danger
    ? "text-octo-mute hover:text-octo-rouge"
    : active
      ? "text-octo-brass hover:text-octo-ivory"
      : "text-octo-mute hover:text-octo-ivory";
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1.5 transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${tone}`}
    >
      {children}
    </button>
  );
}

// ─── Editor ────────────────────────────────────────────────────────────────

function RoutineEditor({
  routine,
  projects,
  pipelines,
  onClose,
}: {
  routine: Routine | null;
  projects: { id: string; name: string }[];
  pipelines: { id: string; name: string }[];
  onClose: () => void;
}) {
  const create = useRoutinesStore((s) => s.create);
  const update = useRoutinesStore((s) => s.update);
  const [draft, setDraft] = useState<RoutineDraft>(() => draftFromRoutine(routine, projects[0]?.id ?? ""));
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof RoutineDraft>(k: K, v: RoutineDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // Switching project invalidates the chosen fixed workspace (it belongs to
  // the old project) — clear it so a stale id can't be saved silently.
  const onProjectChange = (v: string) => setDraft((d) => ({ ...d, projectId: v, fixedWorkspaceId: "" }));

  // A fresh-workspace routine fires at most once a day (phase-1 rule) — coerce to
  // a valid combo when the user picks fresh: an interval becomes daily; a custom
  // schedule keeps its days but drops to a single time (no window).
  const onWorkspaceMode = (v: "fixed" | "fresh") =>
    setDraft((d) => {
      if (v !== "fresh") return { ...d, workspaceMode: v };
      const scheduleKind = d.scheduleKind === "interval" ? "daily" : d.scheduleKind;
      return { ...d, workspaceMode: v, scheduleKind, recurTimeMode: "once" };
    });

  // Load workspaces for the chosen project (fixed mode). Clear any stale
  // selection if the reloaded list no longer contains it.
  useEffect(() => {
    if (!draft.projectId) {
      setWorkspaces([]);
      return;
    }
    let cancelled = false;
    ipc
      .listWorkspaces(draft.projectId)
      .then((ws) => {
        if (cancelled) return;
        setWorkspaces(ws);
        setDraft((d) =>
          d.fixedWorkspaceId && !ws.some((w) => w.id === d.fixedWorkspaceId)
            ? { ...d, fixedWorkspaceId: "" }
            : d,
        );
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.projectId]);

  const onSave = async () => {
    const input = draftToInput(draft);
    if (typeof input === "string") {
      setError(input);
      return;
    }
    // Preserve fields the editor doesn't surface (reference model, per-stage
    // overrides) so editing a routine authored elsewhere doesn't wipe them.
    const full = routine
      ? { ...input, referenceModel: routine.referenceModel, stageOverrides: routine.stageOverrides }
      : input;
    setSaving(true);
    const ok = routine ? await update(routine.id, full) : await create(full);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <ModalShell onClose={onClose} ariaLabel={routine ? "Edit routine" : "Compose a routine"} panelClassName="w-full max-w-[560px]">
      <div className="flex max-h-[82vh] flex-col overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl">
        <div className="border-b border-octo-hairline px-6 pt-5 pb-4">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
            {routine ? "Edit routine" : "New routine"}
          </span>
          <h2 className="mt-1 font-serif text-[18px] leading-tight text-octo-ivory">
            A pipeline, on a schedule.
          </h2>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Field label="Name">
            <TextInput value={draft.name} onChange={(v) => set("name", v)} placeholder="Nightly dependency sweep" autoFocus />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Project">
              <Listbox
                ariaLabel="Project"
                className="w-full"
                triggerClassName={FIELD_SURFACE}
                value={draft.projectId}
                options={[{ value: "", label: "Choose…" }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                onChange={onProjectChange}
              />
            </Field>
            <Field label="Pipeline">
              <Listbox
                ariaLabel="Pipeline"
                className="w-full"
                triggerClassName={FIELD_SURFACE}
                value={draft.pipelineId}
                options={[{ value: "", label: "Choose…" }, ...pipelines.map((p) => ({ value: p.id, label: p.name }))]}
                onChange={(v) => set("pipelineId", v)}
              />
            </Field>
          </div>

          <Field label="Schedule">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={draft.scheduleKind}
                options={
                  // Fresh routines fire ≤ once/day — offer Daily + Custom (single
                  // time); interval is unbounded so it's hidden for fresh.
                  draft.workspaceMode === "fresh"
                    ? [
                        { value: "daily", label: "Daily at" },
                        { value: "recurring", label: "Custom" },
                      ]
                    : [
                        { value: "daily", label: "Daily at" },
                        { value: "interval", label: "Every" },
                        { value: "recurring", label: "Custom" },
                      ]
                }
                onChange={(v) => set("scheduleKind", v as RoutineDraft["scheduleKind"])}
              />
              {draft.scheduleKind === "daily" && (
                <input
                  type="time"
                  value={draft.dailyTime}
                  onChange={(e) => set("dailyTime", e.target.value)}
                  aria-label="Daily time"
                  className="rounded-md border border-octo-border-strong bg-octo-bg px-2 py-1.5 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass"
                />
              )}
              {draft.scheduleKind === "interval" && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={draft.intervalValue}
                    onChange={(e) => set("intervalValue", e.target.value)}
                    aria-label="Interval amount"
                    className="w-16 rounded-md border border-octo-border-strong bg-octo-bg px-2 py-1.5 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass"
                  />
                  <Segmented
                    value={draft.intervalUnit}
                    options={[
                      { value: "minutes", label: "min" },
                      { value: "hours", label: "hrs" },
                    ]}
                    onChange={(v) => set("intervalUnit", v as "minutes" | "hours")}
                  />
                </div>
              )}
            </div>
            {draft.scheduleKind === "recurring" && (
              <RecurringBuilder draft={draft} set={set} setDraft={setDraft} freshOnce={draft.workspaceMode === "fresh"} />
            )}
          </Field>

          <Field label="Workspace">
            <Segmented
              value={draft.workspaceMode}
              options={[
                { value: "fixed", label: "A fixed workspace" },
                { value: "fresh", label: "Fresh each run" },
              ]}
              onChange={(v) => onWorkspaceMode(v as "fixed" | "fresh")}
            />
            {draft.workspaceMode === "fixed" ? (
              <div className="mt-2">
                <Listbox
                  ariaLabel="Workspace"
                  className="w-full"
                  triggerClassName={FIELD_SURFACE}
                  value={draft.fixedWorkspaceId}
                  options={[{ value: "", label: "Choose a workspace…" }, ...workspaces.map((w) => ({ value: w.id, label: w.name }))]}
                  onChange={(v) => set("fixedWorkspaceId", v)}
                />
                <p className="mt-1 text-[11px] leading-snug text-octo-mute">
                  Each fire runs in this workspace. A fire is skipped while a previous run is still going.
                </p>
              </div>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-3">
                <TextInput value={draft.baseBranch} onChange={(v) => set("baseBranch", v)} placeholder="base branch (blank = default)" />
                <TextInput value={draft.branchPrefix} onChange={(v) => set("branchPrefix", v)} placeholder="branch prefix" />
                <p className="col-span-2 text-[11px] leading-snug text-octo-mute">
                  A new worktree is created each run, on a unique branch — the isolated way to ship a change every day. Fresh runs are daily.
                </p>
              </div>
            )}
          </Field>

          <Field label="Brief">
            <textarea
              value={draft.task}
              onChange={(e) => set("task", e.target.value)}
              rows={3}
              placeholder="What should the crew do each run?"
              className="w-full resize-none rounded-md border border-octo-border-strong bg-octo-bg px-3 py-2 text-[13px] leading-[1.5] text-octo-ivory outline-none focus:border-octo-brass placeholder:text-octo-mute"
            />
          </Field>

          <Field label="Fire only if… (optional)">
            <TextInput
              value={draft.fireCondition}
              onChange={(v) => set("fireCondition", v)}
              placeholder="gh pr view --json reviewThreads -q '…' | grep -q ."
              mono
            />
            <p className="mt-1 text-[11px] leading-snug text-octo-mute">
              Runs before each fire in the routine&rsquo;s workspace; the routine fires only if this command exits 0. Leave empty to always fire.
            </p>
          </Field>

          <Field label="Budget per run (optional)">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-octo-mute">$</span>
              <TextInput value={draft.budgetUsd} onChange={(v) => set("budgetUsd", v)} placeholder="no cap" />
            </div>
          </Field>

          {error && <p className="font-mono text-[11px] text-octo-rouge">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-octo-hairline px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving}
            className="rounded-md border border-octo-brass px-4 py-1.5 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] disabled:opacity-50"
          >
            {routine ? "Save the routine" : "Set it in motion"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={mono ? false : undefined}
      className={`w-full rounded-md border border-octo-border-strong bg-octo-bg px-3 py-1.5 text-octo-ivory outline-none focus:border-octo-brass placeholder:text-octo-mute ${
        mono ? "font-mono text-[12px]" : "text-[13px]"
      }`}
    />
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-octo-hairline">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 font-mono text-[11px] transition-colors duration-[180ms] ${
            value === o.value ? "bg-[var(--brass-ghost)] text-octo-brass" : "text-octo-sage hover:text-octo-ivory"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ISO weekday chips (1=Mon … 7=Sun), Monday-first.
const RECUR_DAYS = [
  { lbl: "Mo", v: 1 },
  { lbl: "Tu", v: 2 },
  { lbl: "We", v: 3 },
  { lbl: "Th", v: 4 },
  { lbl: "Fr", v: 5 },
  { lbl: "Sa", v: 6 },
  { lbl: "Su", v: 7 },
];
const STEP_OPTIONS = [
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "180", label: "3 hours" },
];

/** Format a preview instant as "Today · 9:00 AM" / "Wed, Aug 5 · 9:00 AM". */
function formatRun(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(now)) / 86400000);
  const time = to12h(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  if (days === 0) return `Today · ${time}`;
  if (days === 1) return `Tomorrow · ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

/** The Days × Times builder for a `recurring` schedule: presets, day/date and
 *  time controls, a live natural-language summary, and a next-runs preview
 *  (driven by the real backend engine). Mirrors the approved Companion mockup. */
function RecurringBuilder({
  draft,
  set,
  setDraft,
  freshOnce,
}: {
  draft: RoutineDraft;
  set: <K extends keyof RoutineDraft>(k: K, v: RoutineDraft[K]) => void;
  setDraft: (fn: (d: RoutineDraft) => RoutineDraft) => void;
  freshOnce: boolean;
}) {
  const [runs, setRuns] = useState<string[]>([]);
  const spec = recurringSpecOf(draft);

  // Live "next runs" via the real scheduler engine (debounced).
  useEffect(() => {
    if (!spec) {
      setRuns([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      ipc
        .previewRoutineSchedule("recurring", spec, 4)
        .then((r) => !cancelled && setRuns(r))
        .catch(() => !cancelled && setRuns([]));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [spec]);

  const toggleDay = (v: number) =>
    setDraft((d) => ({
      ...d,
      recurDayMode: "weekly",
      recurDays: d.recurDays.includes(v)
        ? d.recurDays.filter((x) => x !== v)
        : [...d.recurDays, v].sort((a, b) => a - b),
    }));

  const applyPreset = (p: string) =>
    setDraft((d) => {
      switch (p) {
        case "everyday":
          return { ...d, recurDayMode: "weekly", recurDays: [1, 2, 3, 4, 5, 6, 7], recurTimeMode: "once" };
        case "weekdays":
          return { ...d, recurDayMode: "weekly", recurDays: [1, 2, 3, 4, 5], recurTimeMode: "once" };
        case "daysofweek":
          return { ...d, recurDayMode: "weekly", recurDays: d.recurDays.length ? d.recurDays : [1, 3, 5], recurTimeMode: "once" };
        case "window":
          return { ...d, recurDayMode: "weekly", recurDays: [1, 2, 3, 4, 5, 6, 7], recurTimeMode: "window", recurStart: "09:00", recurStepMin: "60", recurEnd: "15:00" };
        case "date":
          return { ...d, recurDayMode: "date", recurTimeMode: "once" };
        default:
          return d;
      }
    });

  const presets = [
    { k: "everyday", label: "Every day" },
    { k: "weekdays", label: "Weekdays" },
    { k: "daysofweek", label: "Days of week" },
    ...(freshOnce ? [] : [{ k: "window", label: "Time window" }]),
    { k: "date", label: "On a date" },
  ];

  // Keep a non-preset step (e.g. a 45-min spec authored via MCP) visible in the
  // picker instead of rendering blank.
  const stepOptions = STEP_OPTIONS.some((o) => o.value === draft.recurStepMin)
    ? STEP_OPTIONS
    : [...STEP_OPTIONS, { value: draft.recurStepMin, label: `${draft.recurStepMin} min` }];

  const timeInput =
    "rounded-md border border-octo-hairline bg-octo-bg px-2 py-1.5 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass";
  // Local calendar date (not UTC) so a user at a negative offset can still pick
  // their own "today" for a one-shot.
  const now = new Date();
  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  return (
    <div className="octo-fade-in mt-3 space-y-3.5 rounded-md border border-octo-hairline bg-[var(--brass-faint)] p-3">
      {/* presets */}
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.k}
            type="button"
            onClick={() => applyPreset(p.k)}
            className="rounded-full border border-octo-hairline bg-octo-panel px-2.5 py-1 text-[11.5px] text-octo-sage transition-colors duration-200 hover:border-[var(--brass-quiet)] hover:text-octo-ivory"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* days axis */}
      {draft.recurDayMode === "weekly" ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
          {RECUR_DAYS.map((day) => {
            const on = draft.recurDays.includes(day.v);
            return (
              <button
                key={day.v}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(day.v)}
                className={`flex h-9 w-9 items-center justify-center rounded-md border font-mono text-[12px] transition-colors duration-200 ${
                  on
                    ? "border-[var(--brass-line)] bg-[var(--brass-ghost)] text-octo-brass"
                    : "border-octo-hairline bg-octo-panel text-octo-mute hover:text-octo-ivory"
                }`}
              >
                {day.lbl}
              </button>
            );
          })}
        </div>
      ) : (
        <input
          type="date"
          value={draft.recurDate}
          min={todayISO}
          onChange={(e) => set("recurDate", e.target.value)}
          aria-label="Date"
          className={timeInput}
        />
      )}

      {/* times axis */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={draft.recurTimeMode}
          options={freshOnce ? [{ value: "once", label: "Once" }] : [{ value: "once", label: "Once" }, { value: "window", label: "Window" }]}
          onChange={(v) => set("recurTimeMode", v as RoutineDraft["recurTimeMode"])}
        />
        {draft.recurTimeMode === "once" ? (
          <>
            <span className="text-[12px] text-octo-sage">at</span>
            <input type="time" value={draft.recurAt} onChange={(e) => set("recurAt", e.target.value)} aria-label="Time" className={timeInput} />
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-octo-sage">every</span>
            <Listbox
              ariaLabel="Every"
              triggerClassName={FIELD_SURFACE}
              value={draft.recurStepMin}
              options={stepOptions}
              onChange={(v) => set("recurStepMin", v)}
            />
            <span className="text-[12px] text-octo-sage">from</span>
            <input type="time" value={draft.recurStart} onChange={(e) => set("recurStart", e.target.value)} aria-label="Start time" className={timeInput} />
            <span className="text-[12px] text-octo-sage">to</span>
            <input type="time" value={draft.recurEnd} onChange={(e) => set("recurEnd", e.target.value)} aria-label="End time" className={timeInput} />
          </div>
        )}
      </div>

      {/* live summary */}
      <div className="rounded-md border border-octo-hairline border-l-2 border-l-octo-brass bg-octo-bg px-3 py-2.5">
        <span className="mb-1 block font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">This routine runs</span>
        <p className="font-serif text-[15px] leading-snug text-octo-ivory">{spec ? scheduleSummary("recurring", spec) : "—"}</p>
      </div>

      {/* next-runs preview */}
      <div>
        <span className="mb-1.5 block font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">Next runs</span>
        <div className="divide-y divide-octo-hairline overflow-hidden rounded-md border border-octo-hairline">
          {runs.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-octo-mute">{spec ? "Nothing upcoming" : "Pick a day and time"}</div>
          ) : (
            runs.map((iso, i) => (
              <div key={iso} className="flex items-center justify-between px-3 py-2">
                <span className="font-mono text-[12px] text-octo-ivory">
                  <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle ${i === 0 ? "bg-octo-brass" : "bg-octo-mute"}`} />
                  {formatRun(iso)}
                </span>
                <span className="text-[11.5px] text-octo-sage">{untilLabel(iso)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
