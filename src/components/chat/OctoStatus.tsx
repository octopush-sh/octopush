import { useEffect, useRef, useState } from "react";
import { OctoRig } from "../icons/OctoMark";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type { LiveTool } from "../../stores/chatStore";

export type OctoRole = {
  key: "wait" | "read" | "search" | "edit" | "run" | "write" | "think" | "work";
  label: string;
  bodyClass: string;
};

const ROLE: Record<OctoRole["key"], OctoRole> = {
  wait: { key: "wait", label: "Waiting for you", bodyClass: "octo-mascot--blocked" },
  read: { key: "read", label: "Reading…", bodyClass: "octo-mascot--read" },
  search: { key: "search", label: "Searching…", bodyClass: "octo-mascot--search" },
  edit: { key: "edit", label: "Editing…", bodyClass: "octo-mascot--write" },
  run: { key: "run", label: "Running…", bodyClass: "octo-mascot--run" },
  write: { key: "write", label: "Writing…", bodyClass: "octo-mascot--write" },
  think: { key: "think", label: "Thinking…", bodyClass: "octo-mascot--working" },
  work: { key: "work", label: "Working…", bodyClass: "octo-mascot--working" },
};

const TOOL_FAMILIES: Array<[RegExp, OctoRole["key"]]> = [
  [/^(read|ls|glob|notebookread|cat)/i, "read"],
  [/^(grep|find|search|websearch|webfetch)/i, "search"],
  [/^(edit|write|notebookedit)/i, "edit"],
  [/^(bash|terminal|shell)/i, "run"],
];

/** The Player's script: what is the turn actually doing right now?
 *  Priority: someone must answer (wait) > a live tool > text flowing > thought. */
export function roleForActivity(args: {
  approvals: number;
  liveTools: LiveTool[];
  streamBuffer: string;
}): OctoRole {
  if (args.approvals > 0) return ROLE.wait;
  const live = [...args.liveTools].reverse().find((t) => !t.done);
  if (live) {
    for (const [re, key] of TOOL_FAMILIES) if (re.test(live.toolName)) return ROLE[key];
    return ROLE.work;
  }
  if (args.streamBuffer) return ROLE.write;
  return ROLE.think;
}

/* Exit timings: the beat holds 500ms; the fade matches .octo-fade-out (120ms
   CSS) with a 140ms unmount so the animation always completes first. */
const BEAT_MS = 500;
const FADE_MS = 140;

interface Props {
  /** Identity of the conversation — a change hard-resets the machine so a
   *  workspace switch can never play a phantom ✓ in the wrong chat. */
  workspaceId: string;
  streaming: boolean;
  hasError: boolean;
  /** True when the user pressed Stop this turn — an aborted run leaves
   *  quietly, it is not celebrated. */
  wasStopped: boolean;
  streamBuffer: string;
  liveTools: LiveTool[];
  approvals: number;
}

/** The Player — the pinned bottom-center figure that acts out the turn
 *  (spec 2026-07-19 §4). Stacked on one axis so the label's width can never
 *  move the octopus. Manages its own exit: ✓ beat then fade — beat skipped
 *  on error, on user abort, and under reduced motion. */
export function OctoStatus({
  workspaceId,
  streaming,
  hasError,
  wasStopped,
  streamBuffer,
  liveTools,
  approvals,
}: Props) {
  const reduced = useReducedMotion();
  const active = streaming || approvals > 0;
  const [phase, setPhase] = useState<"hidden" | "live" | "beat" | "fading">(
    active ? "live" : "hidden",
  );
  const prevActive = useRef(active);
  const [label, setLabel] = useState("");
  const [labelSwap, setLabelSwap] = useState(false);

  const role = roleForActivity({ approvals, liveTools, streamBuffer });

  // Exit timers live in a ref — NOT in an effect cleanup keyed on `phase` —
  // because the phase transitions they cause must not cancel them.
  const exitTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const clearExitTimers = () => {
    exitTimers.current.forEach(clearTimeout);
    exitTimers.current = [];
  };

  // Workspace switch = a different conversation, not a turn ending: hard-reset
  // the machine with no exit choreography (review finding: phantom ✓ beat).
  const prevWs = useRef(workspaceId);
  if (prevWs.current !== workspaceId) {
    prevWs.current = workspaceId;
    prevActive.current = active;
    clearExitTimers();
    if (phase !== (active ? "live" : "hidden")) setPhase(active ? "live" : "hidden");
    if (label) setLabel("");
    if (labelSwap) setLabelSwap(false);
  }

  // Enter / exit choreography.
  useEffect(() => {
    const wasActive = prevActive.current;
    prevActive.current = active;
    if (active) {
      clearExitTimers();
      setPhase("live");
      return;
    }
    if (!wasActive) return;
    // A killed or failed turn leaves quietly; reduced motion never beats.
    if (hasError || wasStopped || reduced) {
      setPhase("fading");
      exitTimers.current.push(setTimeout(() => setPhase("hidden"), FADE_MS));
      return;
    }
    setPhase("beat");
    exitTimers.current.push(setTimeout(() => setPhase("fading"), BEAT_MS));
    exitTimers.current.push(setTimeout(() => setPhase("hidden"), BEAT_MS + FADE_MS));
  }, [active, hasError, wasStopped, reduced]);
  useEffect(() => () => clearExitTimers(), []);

  // 220ms label crossfade on change; instant under reduced motion. Leaving
  // "live" resets the swap state so a cleared timer can never strand the
  // label at opacity-0 for the next turn (review finding).
  useEffect(() => {
    if (phase !== "live") {
      if (label) setLabel("");
      if (labelSwap) setLabelSwap(false);
      return;
    }
    if (role.label === label) return;
    if (!label || reduced) {
      setLabel(role.label);
      setLabelSwap(false);
      return;
    }
    setLabelSwap(true);
    const t = setTimeout(() => {
      setLabel(role.label);
      setLabelSwap(false);
    }, 200);
    return () => clearTimeout(t);
  }, [role.label, label, labelSwap, phase, reduced]);

  if (phase === "hidden") return null;

  const beat = phase === "beat";
  const bodyClass = beat ? "octo-mascot--pushed-beat" : role.bodyClass;
  // Label lives only in the live phase — during beat/fade the figure exits
  // alone (review finding: the label used to pop back mid-fade).
  const shownLabel = phase === "live" ? label || role.label : "";

  return (
    <div
      aria-live="polite"
      className={`pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-[5px] ${
        phase === "fading" ? "octo-fade-out" : "octo-rise-in"
      }`}
    >
      <svg
        width="22"
        height="23"
        viewBox="0 0 64 66"
        aria-hidden="true"
        focusable="false"
        className={`octo-mascot ${bodyClass}`}
      >
        <OctoRig eyeR={3.6} showBack={false} withHappy />
      </svg>
      {shownLabel && (
        <span
          className={`whitespace-nowrap font-serif text-[12px] transition-opacity duration-[220ms] ${
            labelSwap ? "opacity-0" : "opacity-100"
          } ${role.key === "wait" ? "text-octo-brass" : "text-octo-sage"}`}
        >
          {shownLabel}
        </span>
      )}
    </div>
  );
}
