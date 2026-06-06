interface ProjectMarkProps {
  size?: number;
  className?: string;
}

/** Faceted-hexagon project mark — brass linework (outline, not filled).
 *  A project reads as a container; its workspaces keep filled tinted
 *  monograms, creating the rail's outline-vs-fill hierarchy. */
export function ProjectMark({ size = 15, className }: ProjectMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <polygon
        points="10,2.5 16.5,6.25 16.5,13.75 10,17.5 3.5,13.75 3.5,6.25"
        stroke="var(--color-octo-brass)"
        strokeWidth="1.3"
      />
      <circle cx="10" cy="10" r="1.6" fill="var(--color-octo-brass)" />
    </svg>
  );
}
