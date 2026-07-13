// Settings → Routines — scheduled crews (Pro). A saved pipeline fires on a
// schedule and drives itself via the detached worker: "every morning there's a
// finished PR waiting." CRUD only; live status lives in Mission Control.
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Pencil, Play, Plus, Power, Trash2 } from "lucide-react";
import { PaneHeader, SectionLabel } from "./shared";
import { ModalShell } from "../ModalShell";
import { useRoutinesStore } from "../../stores/routinesStore";
import { useProjectStore } from "../../stores/projectStore";
import { usePipelineStore } from "../../stores/pipelineStore";
import { useEntitlementStore } from "../../stores/entitlementStore";
import { ipc, type Routine } from "../../lib/ipc";
import type { Workspace } from "../../lib/types";
import { pushToast } from "../Toasts";
import {
  draftFromRoutine,
  draftToInput,
  scheduleSummary,
  untilLabel,
  type RoutineDraft,
} from "../../lib/routineForm";

const ROUTINES_FEATURE = "routines.scheduled";

export function RoutinesPane() {
  const hasFeature = useEntitlementStore((s) => s.hasFeature);
  const entitled = hasFeature(ROUTINES_FEATURE);
  const routines = useRoutinesStore((s) => s.routines);
  const load = useRoutinesStore((s) => s.load);
  const setEnabled = useRoutinesStore((s) => s.setEnabled);
  const remove = useRoutinesStore((s) => s.remove);
  const runNow = useRoutinesStore((s) => s.runNow);
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
        subtitle="Put a pipeline on a schedule — a review each morning, a dependency sweep every few hours. When a routine fires it runs detached, so the crew keeps going even if Octopush is closed."
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
                        {r.enabled && entitled && <span>· next {untilLabel(r.nextDueAt)}</span>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Run-now and enable need entitlement; pause and delete
                          are always available so a downgraded user can clean up. */}
                      {entitled && (
                        <>
                          <IconButton title="Run now" onClick={() => void runNow(r.id)}>
                            <Play size={13} />
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
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  danger?: boolean;
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
      className={`rounded p-1.5 transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)] ${tone}`}
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

  // A fresh-workspace routine must be daily (phase-1 rule) — force it when the
  // user picks fresh, so the schedule control can't hold an invalid combo.
  const onWorkspaceMode = (v: "fixed" | "fresh") =>
    setDraft((d) => ({ ...d, workspaceMode: v, scheduleKind: v === "fresh" ? "daily" : d.scheduleKind }));

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
              <Select value={draft.projectId} onChange={onProjectChange}>
                <option value="">Choose…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Pipeline">
              <Select value={draft.pipelineId} onChange={(v) => set("pipelineId", v)}>
                <option value="">Choose…</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Schedule">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={draft.scheduleKind}
                options={
                  // Fresh routines are daily-only in phase 1 — offer just Daily.
                  draft.workspaceMode === "fresh"
                    ? [{ value: "daily", label: "Daily at" }]
                    : [
                        { value: "daily", label: "Daily at" },
                        { value: "interval", label: "Every" },
                      ]
                }
                onChange={(v) => set("scheduleKind", v as "interval" | "daily")}
              />
              {draft.scheduleKind === "daily" ? (
                <input
                  type="time"
                  value={draft.dailyTime}
                  onChange={(e) => set("dailyTime", e.target.value)}
                  aria-label="Daily time"
                  className="rounded-md border border-octo-hairline bg-octo-bg px-2 py-1.5 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass"
                />
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={draft.intervalValue}
                    onChange={(e) => set("intervalValue", e.target.value)}
                    aria-label="Interval amount"
                    className="w-16 rounded-md border border-octo-hairline bg-octo-bg px-2 py-1.5 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass"
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
                <Select value={draft.fixedWorkspaceId} onChange={(v) => set("fixedWorkspaceId", v)}>
                  <option value="">Choose a workspace…</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
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
              className="w-full resize-none rounded-md border border-octo-hairline bg-octo-bg px-3 py-2 text-[13px] leading-[1.5] text-octo-ivory outline-none focus:border-octo-brass placeholder:text-octo-mute"
            />
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-octo-hairline bg-octo-bg px-3 py-1.5 text-[13px] text-octo-ivory outline-none focus:border-octo-brass placeholder:text-octo-mute"
    />
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-octo-hairline bg-octo-bg px-2.5 py-1.5 text-[13px] text-octo-ivory outline-none focus:border-octo-brass"
    >
      {children}
    </select>
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
