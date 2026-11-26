import { useEffect, useState } from "react";
import { ipc, type CrewReport, type CrewSuggestion, type PipelineWithStages } from "../../lib/ipc";
import { stageName, suggestionConfirm, suggestionCta, suggestionDetail, suggestionDraft, suggestionHeadline, suggestionLine } from "../../lib/crewReport";
import { MENU_HEADER, MENU_SEP } from "../../lib/menuStyles";
import { usePipelineStore } from "../../stores/pipelineStore";
import { useRolesStore } from "../../stores/rolesStore";
import { MenuSurface } from "../MenuSurface";
import { pushToast } from "../Toasts";

interface Props {
  pipeline: PipelineWithStages;
  /** A suggestion was saved; a builtin's lands as a new pipeline id. */
  onApplied: (pipelineId: string, position: number) => void;
  /** A loop hotspot's levers are in the builder. */
  onOpenBuilder: (pipelineId: string) => void;
}

/** The launcher foot's right-sizing line (#983): what this Mac's runs of the
 *  crew suggest, one sans line that opens the suggestions. Each edit is
 *  confirmed first and saved like any builder edit; nothing switches alone. */
export function CrewSuggestionLine({ pipeline, onApplied, onOpenBuilder }: Props) {
  const save = usePipelineStore((s) => s.save);
  const roles = useRolesStore((s) => s.roles);
  const [report, setReport] = useState<CrewReport | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const id = pipeline.pipeline.id;
  // A saved edit changes the stages: read the report again.
  const sig = pipeline.stages.map((s) => `${s.position}:${s.role}:${s.agentModel}:${s.escalateModel ?? ""}`).join("|");
  useEffect(() => {
    let alive = true;
    setReport(null);
    Promise.resolve()
      .then(() => ipc.getCrewReport(id))
      .then((r) => { if (alive) setReport(r ?? null); })
      .catch(() => { if (alive) setReport(null); });
    return () => { alive = false; };
  }, [id, sig]);

  const suggestions = report?.suggestions ?? [];
  if (suggestions.length === 0) return null;
  const byPos = (pos: number | null) => pipeline.stages.find((s) => s.position === pos);
  const names = (s: CrewSuggestion) => [stageName(byPos(s.position), roles, s.role), stageName(byPos(s.senderPosition), roles)] as const;
  const close = () => { setMenu(null); setConfirming(null); };

  const apply = async (s: CrewSuggestion) => {
    const draft = suggestionDraft(pipeline, s);
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await save(draft);
      close();
      onApplied(saved, s.position);
    } catch (e) {
      pushToast({
        level: "error",
        title: "Couldn't change this crew",
        body: (e instanceof Error ? e.message : String(e)).replace(/^other: /, ""),
      });
    } finally {
      setSaving(false);
    }
  };

  const [name, sender] = names(suggestions[0]);
  return (
    <>
      <button
        type="button"
        data-tour="direct-launcher-suggestion"
        data-testid="launcher-crew-suggestion"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title="From this Mac's runs of this crew. Nothing changes until you confirm."
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 6 });
        }}
        className="octo-fade-in min-w-0 truncate text-left text-[11px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory"
      >
        {suggestionLine(suggestions, suggestionHeadline(suggestions[0], name, sender))}
      </button>
      {menu && (
        <MenuSurface x={menu.x} y={menu.y} ariaLabel="Crew suggestions" onDismiss={close} widthClass="w-[320px]">
          <div className={MENU_HEADER}>From this Mac's runs</div>
          {suggestions.map((s, i) => {
            const [n, from] = names(s);
            const editable = s.kind !== "loopHotspot";
            return (
              <div key={`${s.kind}-${s.position}`}>
                {i > 0 && <div className={`${MENU_SEP} my-1`} />}
                <div className="px-3 py-2">
                  <p key={confirming === i ? "confirm" : "offer"} className="octo-fade-in m-0 text-[12px] leading-[1.5] text-octo-sage">
                    {confirming === i ? suggestionConfirm(s, n, pipeline.pipeline.isBuiltin) : suggestionDetail(s, n, from)}
                  </p>
                  <div className="mt-1.5 flex items-baseline gap-3">
                    {confirming === i ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={saving}
                          onClick={() => void apply(s)}
                          className="font-serif text-[12px] text-octo-brass transition-opacity duration-[180ms] hover:opacity-80 disabled:opacity-50"
                        >
                          Change this crew
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={saving}
                          onClick={() => setConfirming(null)}
                          className="font-serif text-[12px] text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage disabled:opacity-50"
                        >
                          Not now
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        title={editable ? "You confirm before anything is saved." : "Effort, instructions and gates are set per stage in the builder."}
                        onClick={() => {
                          if (editable) setConfirming(i);
                          else { close(); onOpenBuilder(id); }
                        }}
                        className="font-serif text-[12px] text-octo-brass transition-opacity duration-[180ms] hover:opacity-80"
                      >
                        {suggestionCta(s, n)}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </MenuSurface>
      )}
    </>
  );
}
