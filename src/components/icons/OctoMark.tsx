export type OctoState = "static" | "idle" | "working" | "pushed" | "blocked";

/** Geometry-only rig — the animated mark's SVG contents without the <svg>
 *  wrapper, so the Watcher/Player (chat mascots) can compose the same
 *  canonical creature and drive it with their own classes/refs. */
export function OctoRig({
  eyeR,
  showBack,
  withHappy = false,
}: {
  eyeR: number;
  showBack: boolean;
  withHappy?: boolean;
}) {
  const eyeFill = "var(--octo-eye, var(--color-octo-bg))";
  return (
    <>
      {showBack && (
        <g fill="var(--brass-line)">
          <circle className="octo-m-b1" cx="10" cy="48.5" r="5" />
          <circle className="octo-m-b2" cx="21" cy="50" r="5" />
          <circle className="octo-m-b3" cx="43" cy="50" r="5" />
          <circle className="octo-m-b4" cx="54" cy="48.5" r="5" />
        </g>
      )}
      <path
        fill="var(--color-octo-brass)"
        d="M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47 L10 47 Z"
      />
      <g fill="var(--color-octo-brass)">
        <ellipse className="octo-m-f1" cx="15.5" cy="47" rx="5.5" ry="5.2" />
        <ellipse className="octo-m-f2" cx="26.5" cy="47" rx="5.5" ry="5.2" />
        <ellipse className="octo-m-f3" cx="37.5" cy="47" rx="5.5" ry="5.2" />
        <ellipse className="octo-m-f4" cx="48.5" cy="47" rx="5.5" ry="5.2" />
      </g>
      {/* Eyes ride in their own group: eye-group transforms (scan, gaze)
          and per-eye transforms (blink) must not share an element — CSS
          animations on the SAME element's transform override each other. */}
      <g className="octo-m-eyes">
        <ellipse className="octo-m-eye" cx="25" cy="27" rx={eyeR} ry={eyeR} fill={eyeFill} />
        <ellipse className="octo-m-eye" cx="39" cy="27" rx={eyeR} ry={eyeR} fill={eyeFill} />
      </g>
      {withHappy && (
        <g
          className="octo-m-happy"
          stroke={eyeFill}
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M21.8 28 Q25 24.8 28.2 28" />
          <path d="M35.8 28 Q39 24.8 42.2 28" />
        </g>
      )}
    </>
  );
}

interface OctoMarkProps {
  /** Rendered width in px; height keeps the 64:66 canonical ratio. */
  size?: number;
  /** "static" renders the plain artwork; the rest are CSS-animated rigs. */
  state?: OctoState;
  className?: string;
}

/** The Octo — Octopush's mark and mascot (spec:
 *  docs/superpowers/specs/2026-07-11-octopush-logo-brand-design.md).
 *  Solid brass creature on the surface behind it: dome head, two
 *  negative-space eyes, four front arms, four muted back arms.
 *  Body language mirrors app state: idle floats, working paddles and
 *  scans, pushed rises once with a brass halo, blocked freezes.
 *  Below 20px the back-arm row is dropped; the eyes never are. */
export function OctoMark({ size = 20, state = "static", className }: OctoMarkProps) {
  const height = Math.round((size * 66) / 64);
  const showBack = size >= 20;
  const eyeR = size < 24 ? 3.6 : 3;
  const eyeFill = "var(--octo-eye, var(--color-octo-bg))";

  const backArms = showBack ? (
    <g fill="var(--brass-line)">
      <circle className="octo-m-b1" cx="10" cy="48.5" r="5" />
      <circle className="octo-m-b2" cx="21" cy="50" r="5" />
      <circle className="octo-m-b3" cx="43" cy="50" r="5" />
      <circle className="octo-m-b4" cx="54" cy="48.5" r="5" />
    </g>
  ) : null;

  if (state === "static") {
    return (
      <svg
        width={size}
        height={height}
        viewBox="0 0 64 66"
        aria-hidden="true"
        focusable="false"
        className={className}
      >
        {backArms}
        <path
          fill="var(--color-octo-brass)"
          d="M10 30 C10 17.8 19.8 8 32 8 C44.2 8 54 17.8 54 30 L54 47 A5.5 5.5 0 0 1 43 47 A5.5 5.5 0 0 1 32 47 A5.5 5.5 0 0 1 21 47 A5.5 5.5 0 0 1 10 47 Z"
        />
        <circle cx="25" cy="27" r={eyeR} fill={eyeFill} />
        <circle cx="39" cy="27" r={eyeR} fill={eyeFill} />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 64 66"
      aria-hidden="true"
      focusable="false"
      className={`octo-mascot octo-mascot--${state}${className ? ` ${className}` : ""}`}
    >
      {state === "pushed" && (
        <circle
          className="octo-m-ring"
          cx="32"
          cy="30"
          r="13"
          fill="none"
          stroke="var(--color-octo-brass)"
          strokeWidth="1.5"
          opacity="0"
        />
      )}
      <g className="octo-m-body">
        <OctoRig eyeR={eyeR} showBack={showBack} withHappy />
      </g>
    </svg>
  );
}
