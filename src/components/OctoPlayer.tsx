import { useEffect, useRef, useState } from "react";
import { OctoRig } from "./icons/OctoMark";
import { useReducedMotion } from "../hooks/useReducedMotion";

/** A role the pinned Player can act out (spec 2026-07-19 §4). */
export type OctoRole = {
  key: "wait" | "read" | "search" | "edit" | "run" | "write" | "think" | "work";
  label: string;
  bodyClass: string;
};

export const ROLES: Record<OctoRole["key"], OctoRole> = {
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

/** Map a tool name to its acted role, or null for tools outside the four
 *  families (callers fall back to ROLES.work). */
export function roleForToolName(name: string): OctoRole | null {
  for (const [re, key] of TOOL_FAMILIES) if (re.test(name)) return ROLES[key];
  return null;
}

/* Exit timings: the beat holds 500ms; the fade matches .octo-fade-out (120ms
   CSS) with a 140ms unmount so the animation always completes first. */
const BEAT_MS = 500;
const FADE_MS = 140;

interface Props {
  /** Identity of the surface being narrated (workspace id in TALK, stage id
   *  in DIRECT) — a change hard-resets the machine so switching surfaces can
   *  never play a phantom ✓ in the wrong place. */
  identity: string;
  /** True while there is something to narrate (streaming / stage running /
   *  someone must answer). Flipping false triggers the exit choreography. */
  active: boolean;
  /** What the turn/stage is doing right now — drives body class + label. */
  role: OctoRole;
  /** True when this deactivation must not be celebrated (error, user abort,
   *  failed stage). Reduced motion also skips the beat. */
  skipBeat: boolean;
}

/** The Player — the pinned bottom-center figure that acts out live work
 *  (spec 2026-07-19 §4). Mode-agnostic: TALK (OctoStatus) and DIRECT
 *  (StageOctoStatus) feed it identity/active/role/skipBeat. Stacked on one
 *  axis so the label's width can never move the octopus; manages its own
 *  exit (✓ beat then fade). */
export function OctoPlayer({ identity, active, role, skipBeat }: Props) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<"hidden" | "live" | "beat" | "fading">(
    active ? "live" : "hidden",
  );
  const prevActive = useRef(active);
  const [label, setLabel] = useState("");
  const [labelSwap, setLabelSwap] = useState(false);

  // Exit timers live in a ref — NOT in an effect cleanup keyed on `phase` —
  // because the phase transitions they cause must not cancel them.
  const exitTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const clearExitTimers = () => {
    exitTimers.current.forEach(clearTimeout);
    exitTimers.current = [];
  };

  // Surface switch = a different story, not an ending: hard-reset the
  // machine with no exit choreography (review finding: phantom ✓ beat).
  const prevIdentity = useRef(identity);
  if (prevIdentity.current !== identity) {
    prevIdentity.current = identity;
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
    if (skipBeat || reduced) {
      setPhase("fading");
      exitTimers.current.push(setTimeout(() => setPhase("hidden"), FADE_MS));
      return;
    }
    setPhase("beat");
    exitTimers.current.push(setTimeout(() => setPhase("fading"), BEAT_MS));
    exitTimers.current.push(setTimeout(() => setPhase("hidden"), BEAT_MS + FADE_MS));
  }, [active, skipBeat, reduced]);
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
    if (role.label === label) {
      // The role flickered away and back within the 200ms swap window (e.g.
      // chained Bash commands: Running… → Thinking… → Running…): the pending
      // swap timer was cleared by this effect's cleanup, so the swap flag
      // must be released here or the label stays at opacity-0 forever.
      if (labelSwap) setLabelSwap(false);
      return;
    }
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
