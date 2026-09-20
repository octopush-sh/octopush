interface ProjectMarkProps {
  size?: number;
  className?: string;
  /** Stroke/core colour. Brass by default; the rail passes mute for an
   *  untinted project and the project's tint accent when the user chose one,
   *  so N projects never mean N brass hexagons. */
  color?: string;
}

/** Faceted-hexagon project mark — linework (outline, not filled).
 *  A project reads as a container; its workspaces keep their tinted
 *  monogram glyphs, creating the rail's outline-vs-glyph hierarchy. */
export function ProjectMark({
  size = 15,
  className,
  color = "var(--color-octo-brass)",
}: ProjectMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <polygon
        points="10,2.5 16.5,6.25 16.5,13.75 10,17.5 3.5,13.75 3.5,6.25"
        stroke={color}
        strokeWidth="1.3"
      />
      <circle cx="10" cy="10" r="1.6" fill={color} />
    </svg>
  );
}
