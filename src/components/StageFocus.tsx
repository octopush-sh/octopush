import { useEffect, useMemo, useRef, useState } from "react";
import type { RunStage } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { labelForRole } from "./RunTrack";
import { DiffViewer } from "./DiffViewer";

interface ParsedArtifact {
  kind: string;
  text: string;
  refsWorktree?: boolean;
}

interface Props {
  stage: RunStage | null;
  workspacePath: string;
}

export function StageFocus({ stage, workspacePath }: Props) {
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const liveLog = useRunsStore((s) => s.liveLogByStage[stage?.id ?? ""] ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);

  const artifact = useMemo<ParsedArtifact | null>(() => {
    if (!stage?.artifact) return null;
    try {
      return JSON.parse(stage.artifact) as ParsedArtifact;
    } catch {
      return null;
    }
  }, [stage?.artifact]);

  useEffect(() => {
    let cancelled = false;
    if (stage && artifact?.refsWorktree && workspacePath) {
      setDiff("");
      setDiffLoading(true);
      ipc.getGitDiff(workspacePath)
        .then((d) => { if (!cancelled) { setDiff(d); setDiffLoading(false); } })
        .catch(() => { if (!cancelled) { setDiff(""); setDiffLoading(false); } });
    } else {
      setDiff("");
      setDiffLoading(false);
    }
    return () => { cancelled = true; };
  }, [stage?.id, stage?.status, artifact?.refsWorktree, workspacePath]);

  // Keep the live log pinned to the newest activity while a stage runs.
  useEffect(() => {
    if (stage?.status === "running" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [liveLog, stage?.status]);

  if (!stage) {
    return (
      <div className="flex flex-1 items-center justify-center text-octo-mute font-mono text-sm">
        Select a stage to inspect it.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden octo-fade-in">
      <div className="flex items-center gap-2 border-b border-octo-hairline px-4 py-2.5 font-mono text-xs text-octo-sage">
        <span className="text-octo-brass">§ {stage.role.toUpperCase()}</span>
        <span>· {labelForRole(stage.role)} · {stage.agentModel}</span>
        <span className="ml-auto text-octo-brass">${stage.costUsd.toFixed(2)}</span>
      </div>
      <div
        ref={scrollRef}
        className="chat-selectable flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-octo-sage whitespace-pre-wrap"
      >
        {stage.status === "failed" && stage.error ? (
          <span className="text-octo-rouge">{stage.error}</span>
        ) : artifact ? (
          <>
            {artifact.text || "(no output text)"}
            {artifact.refsWorktree &&
              (diffLoading ? (
                <div className="p-4 font-mono text-xs text-octo-mute">Loading diff…</div>
              ) : (
                <DiffViewer diff={diff} />
              ))}
          </>
        ) : stage.status === "running" ? (
          liveLog ? (
            <>
              {liveLog}
              {"\n"}
              <span className="text-octo-brass">working…</span>
            </>
          ) : (
            <span className="text-octo-brass">working…</span>
          )
        ) : (
          <span className="text-octo-mute">No artifact yet.</span>
        )}
      </div>
    </div>
  );
}
