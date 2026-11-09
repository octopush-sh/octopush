import { useEffect, useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import { ipc, type CrewPreview } from "../lib/ipc";
import { ModalShell } from "./ModalShell";
import { ModelPicker } from "./ModelPicker";
import { pushToast } from "./Toasts";
import { useCrewImportStore } from "../stores/crewImportStore";
import { usePipelineStore } from "../stores/pipelineStore";
import { useRolesStore } from "../stores/rolesStore";
import { useProvidersStore } from "../stores/providersStore";
import { catalogModelIds, flaggedModels, modelFlagText, pickCrewFile, POWER_TOOLS } from "../lib/crew";

/** Mounts the sheet while the import store says so. */
export function CrewImportHost() {
  const open = useCrewImportStore((s) => s.open);
  const text = useCrewImportStore((s) => s.text);
  const origin = useCrewImportStore((s) => s.origin);
  if (!open) return null;
  // Re-key on the text: a new file starts a fresh review (no stale swaps).
  return <CrewImportSheet key={text} text={text} origin={origin} />;
}

// Backend errors arrive as "other: <sentence>"; the sentence is what to show.
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^other: /, "");

/**
 * The crew import review. A crew is prompt text plus tool permissions that
 * will run in a worktree, so nothing is saved until the user has seen every
 * stage — writer or read-only, its tools, its full instructions, the custom
 * roles' prompts and any model the app can't price — and confirms. Import
 * never starts a run; the result is a normal, editable custom pipeline.
 */
export function CrewImportSheet({ text, origin }: { text: string; origin: string | null }) {
  const close = useCrewImportStore((s) => s.close);
  const show = useCrewImportStore((s) => s.show);
  const providers = useProvidersStore((s) => s.providers);
  const [preview, setPreview] = useState<CrewPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [swaps, setSwaps] = useState<Record<string, string>>({});
  const [paste, setPaste] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void useProvidersStore.getState().refresh();
  }, []);

  const swapPairs = useMemo(() => Object.entries(swaps) as [string, string][], [swaps]);

  useEffect(() => {
    if (!text) return;
    let alive = true;
    ipc
      .previewCrew(text, swapPairs)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        setLoadError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setPreview(null);
        setLoadError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [text, swapPairs]);

  const catalog = useMemo(() => catalogModelIds(providers), [providers]);
  // Flags are computed on the file's models, so a replaced model keeps its row.
  const [flags, setFlags] = useState<ReturnType<typeof flaggedModels>>([]);
  useEffect(() => {
    if (preview && swapPairs.length === 0) setFlags(flaggedModels(preview, catalog));
  }, [preview, catalog, swapPairs.length]);

  const add = async () => {
    if (!preview?.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      await ipc.importCrew(text, swapPairs);
      // The crew is saved; a failed list refresh must not read as a failed import.
      await Promise.allSettled([usePipelineStore.getState().load(), useRolesStore.getState().load()]);
      pushToast({ level: "success", title: "Crew added to your library", body: preview.name });
      close();
    } catch (e) {
      setSaveError(errorText(e));
      setSaving(false);
    }
  };

  const writers = preview?.stages.filter((s) => !s.readOnly).length ?? 0;

  return (
    <ModalShell onClose={close} closeOnBackdrop={false} ariaLabel="Import a crew" panelClassName="w-full max-w-[720px]">
      <div
        data-tour="crew-import-sheet"
        className="flex max-h-[84vh] flex-col rounded-xl border border-octo-hairline bg-octo-panel shadow-2xl"
      >
        <div className="border-b border-octo-hairline px-6 pb-4 pt-5">
          <p className="mb-1 truncate font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
            import a crew{origin ? ` · ${origin}` : ""}
          </p>
          <h2 className="m-0 font-serif text-[20px] tracking-[-0.005em] text-octo-ivory">
            {preview ? preview.name || "Untitled crew" : "Bring in a crew"}
          </h2>
          {preview?.description && <p className="m-0 mt-1 text-[12px] text-octo-sage">{preview.description}</p>}
          <p className="m-0 mt-2 font-mono text-[10px] text-octo-mute">
            Nothing runs on import. Read what each stage may do before you add it.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {!text ? (
            <div className="octo-fade-in flex flex-col gap-3">
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                aria-label="Crew JSON"
                placeholder="Paste a crew's JSON here"
                className="h-40 w-full resize-none rounded-md border border-octo-border-strong bg-octo-onyx p-3 font-mono text-[11px] text-octo-ivory outline-none transition-colors duration-[180ms] placeholder:font-serif placeholder:text-octo-mute focus:border-[var(--brass-dim)]"
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={!paste.trim()}
                  onClick={() => show(paste.trim(), "pasted")}
                  className="rounded-md border border-octo-brass px-3 py-1.5 font-serif text-[13px] text-octo-brass transition-opacity duration-[180ms] disabled:opacity-40"
                >
                  Review this crew
                </button>
                <button
                  type="button"
                  onClick={() => void pickCrewFile()}
                  title="Choose a crew file"
                  className="flex items-center gap-1.5 font-mono text-[11px] text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass"
                >
                  <FileUp size={12} aria-hidden /> or choose a .octocrew.json file
                </button>
              </div>
            </div>
          ) : loadError ? (
            <div className="octo-fade-in">
              <p className="m-0 font-mono text-[11px] text-octo-rouge">{loadError}</p>
              <button
                type="button"
                onClick={() => show("")}
                className="mt-3 font-mono text-[11px] text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass"
              >
                Try another crew
              </button>
            </div>
          ) : !preview ? (
            <p className="m-0 font-mono text-[11px] text-octo-mute">Reading the crew…</p>
          ) : (
            <div className="octo-fade-in flex flex-col gap-5">
              {preview.problems.length > 0 && (
                <ul className="m-0 list-none p-0" data-testid="crew-problems">
                  {preview.problems.map((p) => (
                    <li key={p} className="font-mono text-[11px] text-octo-rouge">{p}</li>
                  ))}
                </ul>
              )}

              {flags.length > 0 && (
                <section>
                  <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">models to check</p>
                  {flags.map((f) => (
                    <div key={f.model} className="flex items-center gap-3 py-1" data-testid="crew-model-flag">
                      <span className="min-w-0 truncate font-mono text-[11px] text-octo-ivory">{f.model}</span>
                      <span className="shrink-0 font-mono text-[10px] text-octo-warning">{modelFlagText(f)}</span>
                      <div className="ml-auto w-[220px] shrink-0">
                        <ModelPicker
                          activeModel={swaps[f.model] ?? f.model}
                          onSelectModel={(m) => setSwaps((prev) => ({ ...prev, [f.model]: m }))}
                        />
                      </div>
                    </div>
                  ))}
                </section>
              )}

              <section>
                <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
                  {preview.stages.length} {preview.stages.length === 1 ? "stage" : "stages"} · {writers} can change files
                </p>
                <ol className="m-0 flex list-none flex-col gap-3 p-0">
                  {preview.stages.map((s) => (
                    <li
                      key={s.position}
                      data-testid="crew-stage"
                      className={`rounded-md border px-3 py-2.5 ${s.problem ? "border-octo-rouge" : "border-octo-hairline"} bg-octo-panel-2`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[10px] text-octo-mute">{s.position + 1}</span>
                        <span className="min-w-0 truncate font-serif text-[14px] text-octo-ivory">{s.label}</span>
                        <span
                          className={`ml-auto shrink-0 font-mono text-[10px] ${s.readOnly ? "text-octo-sage" : "text-octo-warning"}`}
                          title={s.readOnly ? "Can't change the worktree" : "Can change files in the worktree"}
                        >
                          {s.readOnly ? "read-only" : "writer"}
                        </span>
                      </div>
                      <p className="m-0 mt-1 truncate font-mono text-[10px] text-octo-mute">
                        {s.role} · {s.agentModel} · {s.substrate}
                        {s.escalateModel ? ` · escalates to ${s.escalateModel}` : ""}
                        {s.checkpoint ? " · waits for you" : ""}
                      </p>
                      {s.actionRole && (
                        <p className="m-0 mt-1 font-mono text-[10px] text-octo-warning">may commit, push and run release commands</p>
                      )}
                      <p className="m-0 mt-1 font-mono text-[10px]">
                        {s.tools.map((t, i) => (
                          <span key={t} className={POWER_TOOLS.has(t) ? "text-octo-warning" : "text-octo-sage"}>
                            {i > 0 ? " · " : ""}
                            {t}
                          </span>
                        ))}
                      </p>
                      {s.instructions && (
                        <pre className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-octo-onyx p-2 font-mono text-[10px] leading-[1.5] text-octo-ivory">
                          {s.instructions}
                        </pre>
                      )}
                      {/* The backend's message already names the stage once. */}
                      {s.problem && <p className="m-0 mt-1.5 font-mono text-[11px] text-octo-rouge">{s.problem}</p>}
                    </li>
                  ))}
                </ol>
              </section>

              {preview.roles.length > 0 && (
                <section>
                  <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">custom roles</p>
                  <div className="flex flex-col gap-3">
                    {preview.roles.map((r) => (
                      <div key={r.originalKey} data-testid="crew-role" className="rounded-md border border-octo-hairline bg-octo-panel-2 px-3 py-2.5">
                        <div className="flex items-baseline gap-2">
                          <span className="font-serif text-[14px] text-octo-ivory">{r.label}</span>
                          <span className="font-mono text-[10px] text-octo-mute">{r.key}</span>
                          <span className="ml-auto font-mono text-[10px] text-octo-sage">
                            {r.fate === "renamed"
                              ? `saved as ${r.key} · ${r.originalKey} is taken here`
                              : r.fate === "existing"
                                ? "already in your library"
                                : "new role"}
                          </span>
                        </div>
                        <pre className="m-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-octo-onyx p-2 font-mono text-[10px] leading-[1.5] text-octo-ivory">
                          {r.promptBody}
                        </pre>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-octo-hairline px-6 py-3">
          <button
            type="button"
            data-tour="crew-import-add"
            disabled={!preview?.ok || saving}
            onClick={() => void add()}
            className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi disabled:opacity-40"
          >
            Add this crew to my library
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-octo-border-strong px-3 py-2 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage"
          >
            Cancel
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
            {saveError ? (
              <span className="text-octo-rouge">{saveError}</span>
            ) : preview && !preview.ok ? (
              <span className="text-octo-rouge">Fix the crew file first — nothing was saved.</span>
            ) : null}
          </span>
        </div>
      </div>
    </ModalShell>
  );
}
