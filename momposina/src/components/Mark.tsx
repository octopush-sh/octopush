type MarkProps = { className?: string; title?: string };

/**
 * La marca gráfica: una pepita.
 *
 * Un pentágono irregular — la forma en que el oro aparece antes de que
 * alguien lo trabaje. No es un diamante, no es una corona, y a 16 px
 * todavía se lee.
 */
export function Mark({ className, title }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d="M16 4 L26 11 L22.5 24 L10 27 L4.5 14 Z" fill="currentColor" />
      <path
        d="M16 4 L13 17 L22.5 24"
        fill="none"
        stroke="var(--color-m-carbon)"
        strokeWidth="1.1"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  );
}
