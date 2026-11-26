import { useEffect, useMemo, useState } from "react";
import { ipc, type ClaudeModelFloorNote, type PipelineWithStages } from "../../lib/ipc";
import { loadClaudeCliVersion } from "../../lib/claudeCli";
import {
  keepLabel, pipelineSupersessions, supersededLine, supersededOnCli, supersessionMap, switchedDraft,
} from "../../lib/supersededModels";
import { usePipelineStore } from "../../stores/pipelineStore";
import { useProvidersStore } from "../../stores/providersStore";
import { useSupersededModelStore } from "../../stores/supersededModelStore";
import { pushToast } from "../Toasts";

interface Props {
  pipeline: PipelineWithStages;
  /** The saved pipeline's id — a builtin's switch forks it into a new one. */
  onSwitched: (pipelineId: string, fromId: string, toId: string) => void;
}

/** The launcher's one quiet line for a crew on a model the catalog marks as
 *  replaced ("Fable 5.1 → Fable 5.2: about 20% cheaper per token."). The user
 *  switches that crew or keeps it; nothing is ever switched for them. */
export function SupersededModelLine({ pipeline, onSwitched }: Props) {
  const providers = useProvidersStore((s) => s.providers);
  const providersLoaded = useProvidersStore((s) => s.loaded);
  const refreshProviders = useProvidersStore((s) => s.refresh);
  const kept = useSupersededModelStore((s) => s.kept[pipeline.pipeline.id]);
  const keep = useSupersededModelStore((s) => s.keep);
  const save = usePipelineStore((s) => s.save);
  const [saving, setSaving] = useState(false);
  const [floor, setFloor] = useState<ClaudeModelFloorNote | null>(null);

  useEffect(() => { if (!providersLoaded) void refreshProviders(); }, [providersLoaded, refreshProviders]);

  const map = useMemo(() => supersessionMap(providers), [providers]);
  const offer = pipelineSupersessions(pipeline, map).find(
    (s) => !(kept ?? []).includes(s.from.id) && supersededLine(s) != null,
  );
  const fromId = offer?.from.id ?? null;
  const toId = offer?.to.id ?? null;
  const onCli = !!fromId && supersededOnCli(pipeline, fromId);

  // A CLI stage on the replacement may need a newer Claude Code; an unknown
  // version never warns (the launcher's own floor note follows the same rule).
  useEffect(() => {
    setFloor(null);
    if (!onCli || !toId) return;
    let alive = true;
    void loadClaudeCliVersion()
      .then((v) => (v?.version ? ipc.claudeModelFloorNote([toId]) : null))
      .then((n) => { if (alive) setFloor(n ?? null); })
      .catch(() => {});
    return () => { alive = false; };
  }, [onCli, toId]);

  if (!offer || !fromId || !toId) return null;

  const switchCrew = async () => {
    setSaving(true);
    try {
      const id = await save(switchedDraft(pipeline, fromId, toId));
      onSwitched(id, fromId, toId);
    } catch (e) {
      pushToast({
        level: "error",
        title: "Couldn't switch this crew",
        body: (e instanceof Error ? e.message : String(e)).replace(/^other: /, ""),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-tour="pipeline-model-superseded"
      data-testid="pipeline-model-superseded"
      className="octo-rise-in mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"
    >
      <span className="octo-tabular font-mono text-[11px] text-octo-sage">{supersededLine(offer)}</span>
      {floor && (
        <span className="octo-tabular font-mono text-[11px] text-octo-warning">
          {floor.label} needs Claude Code {floor.needs} or newer.
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-baseline gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void switchCrew()}
          title={`Every stage of this crew on ${fromId}, escalations included, moves to ${toId}. You can change it back in the builder.`}
          className="font-serif text-[12px] text-octo-brass transition-opacity duration-[180ms] hover:opacity-80 disabled:opacity-50"
        >
          Switch this crew
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => keep(pipeline.pipeline.id, fromId)}
          title="Stop suggesting this for this crew"
          className="font-serif text-[12px] text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage disabled:opacity-50"
        >
          {keepLabel(offer)}
        </button>
      </span>
    </div>
  );
}
