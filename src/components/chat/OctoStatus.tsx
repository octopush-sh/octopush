import { useEffect, useRef, useState } from "react";
import { OctoRig } from "../icons/OctoMark";
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

interface Props {
  streaming: boolean;
  hasError: boolean;
  streamBuffer: string;
  liveTools: LiveTool[];
  approvals: number;
}

/** The Player — the pinned bottom-center figure that acts out the turn
 *  (spec 2026-07-19 §4). Stacked on one axis so the label's width can never
 *  move the octopus. Manages its own exit: ✓ beat (500ms) then fade (220ms). */
export function OctoStatus({ streaming, hasError, streamBuffer, liveTools, approvals }: Props) {
  const active = streaming || approvals > 0;
  const [phase, setPhase] = useState<"hidden" | "live" | "beat" | "fading">(
    active ? "live" : "hidden",
  );
  const prevActive = useRef(active);
  const [label, setLabel] = useState("");
  const [labelSwap, setLabelSwap] = useState(false);

  const role = roleForActivity({ approvals, liveTools, streamBuffer });

  // Enter / exit choreography. Exit timers live in a ref — NOT in the
  // effect's cleanup — because the phase transitions they cause must not
  // cancel them (an effect keyed on `phase` would clear its own timers).
  const exitTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => {
    const wasActive = prevActive.current;
    prevActive.current = active;
    if (active) {
      exitTimers.current.forEach(clearTimeout);
      exitTimers.current = [];
      setPhase("live");
      return;
    }
    if (!wasActive) return;
    if (hasError) {
      setPhase("fading");
      exitTimers.current.push(setTimeout(() => setPhase("hidden"), 220));
      return;
    }
    setPhase("beat");
    exitTimers.current.push(setTimeout(() => setPhase("fading"), 500));
    exitTimers.current.push(setTimeout(() => setPhase("hidden"), 720));
  }, [active, hasError]);
  useEffect(() => () => exitTimers.current.forEach(clearTimeout), []);

  // 220ms label crossfade on change.
  useEffect(() => {
    if (phase !== "live") return;
    if (role.label === label) return;
    if (!label) {
      setLabel(role.label);
      return;
    }
    setLabelSwap(true);
    const t = setTimeout(() => {
      setLabel(role.label);
      setLabelSwap(false);
    }, 200);
    return () => clearTimeout(t);
  }, [role.label, label, phase]);

  if (phase === "hidden") return null;

  const beat = phase === "beat";
  const bodyClass = beat ? "octo-mascot--pushed-beat" : role.bodyClass;
  const shownLabel = beat ? "" : label || role.label;

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
