import { cn } from "../../lib/cn";

type SectionProps = {
  id?: string;
  children: React.ReactNode;
  /** Fondo. El carbón se reserva para los tres momentos de la página. */
  surface?: "crudo" | "papel" | "carbon";
  className?: string;
  /** Sin límite de ancho: para las secciones a sangre. */
  bleed?: boolean;
  labelledBy?: string;
};

const surfaces = {
  crudo: "bg-m-crudo text-m-tinta",
  papel: "bg-m-papel text-m-tinta",
  carbon: "on-dark bg-m-carbon text-m-crema",
} as const;

/** Ritmo vertical de la página. Un solo sitio donde se decide el aire. */
export function Section({
  id,
  children,
  surface = "crudo",
  className,
  bleed,
  labelledBy,
}: SectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(surfaces[surface], "relative", className)}
    >
      <div className={cn(bleed ? "w-full" : "mx-auto w-full max-w-[78rem] px-6 md:px-10")}>
        {children}
      </div>
    </section>
  );
}

/** Rejilla editorial de dos columnas, asimétrica en escritorio. */
export function Spread({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-10 md:grid-cols-12 md:gap-14", className)}>{children}</div>
  );
}
