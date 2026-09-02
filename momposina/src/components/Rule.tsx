import { useReveal } from "../hooks/useReveal";
import { cn } from "../lib/cn";

/**
 * El filete. Crece desde la izquierda al entrar en pantalla.
 * Línea sólida siempre: un degradado usado como regla es un adorno.
 */
export function Rule({ className }: { className?: string }) {
  const ref = useReveal<HTMLSpanElement>(0.5);
  return <span ref={ref} aria-hidden="true" className={cn("m-rule", className)} />;
}
