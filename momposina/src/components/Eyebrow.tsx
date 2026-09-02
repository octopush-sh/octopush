import { cn } from "../lib/cn";

type EyebrowProps = {
  children: React.ReactNode;
  /** Numeración de sección. Cifras arábigas, nunca romanas. */
  index?: string;
  className?: string;
};

/** Etiqueta en versalitas espaciadas: la voz que "anota" la página. */
export function Eyebrow({ children, index, className }: EyebrowProps) {
  return (
    <p className={cn("m-eyebrow flex items-baseline gap-3", className)}>
      {index && <span className="m-num opacity-70">{index}</span>}
      <span>{children}</span>
    </p>
  );
}
