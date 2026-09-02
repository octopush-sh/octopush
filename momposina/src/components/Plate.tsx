import type { PhotoSlot, PlateTone } from "../content/media";
import { cn } from "../lib/cn";

/**
 * Un hueco de fotografía.
 *
 * Mientras no exista el material real, renderiza una plancha mineral con el
 * encuadre que hay que hacer. Es deliberado: construir el diseño sobre fotos
 * de banco lo habría hecho parecerse a cualquier otra joyería, y estos huecos
 * dicen la verdad sobre en qué punto está la marca.
 *
 * En cuanto `slot.src` deja de ser null, se imprime la fotografía —
 * responsive, diferida y con la misma proporción, así que el layout no salta.
 */

const tones: Record<PlateTone, { surface: string; ink: string; line: string }> = {
  carbon: { surface: "bg-m-carbon-2", ink: "text-m-ceniza", line: "border-m-crema/12" },
  mineral: { surface: "bg-m-mineral", ink: "text-m-crema/75", line: "border-m-crema/15" },
  tierra: { surface: "bg-m-tierra", ink: "text-m-crema/75", line: "border-m-crema/18" },
  piedra: { surface: "bg-m-piedra", ink: "text-m-carbon/70", line: "border-m-carbon/15" },
  oro: { surface: "bg-m-oro-tierra", ink: "text-m-crema/80", line: "border-m-crema/20" },
};

type PlateProps = {
  slot: PhotoSlot;
  className?: string;
  /** La imagen del hero no se difiere: es el LCP. */
  priority?: boolean;
  sizes?: string;
};

export function Plate({ slot, className, priority, sizes = "100vw" }: PlateProps) {
  const tone = tones[slot.tone];

  if (slot.src) {
    return (
      <img
        src={slot.src}
        alt={slot.alt}
        sizes={sizes}
        loading={priority ? "eager" : "lazy"}
        decoding={priority ? "sync" : "async"}
        {...(priority ? { fetchPriority: "high" as const } : {})}
        style={{ aspectRatio: slot.ratio }}
        className={cn("h-full w-full object-cover", className)}
      />
    );
  }

  return (
    <div
      style={{ aspectRatio: slot.ratio }}
      className={cn("relative w-full overflow-hidden", tone.surface, className)}
      role="img"
      aria-label={`Fotografía pendiente: ${slot.brief}`}
    >
      {/* Marco interior y marcas de encuadre: lenguaje de contacto de
          fotografía, no de tarjeta de producto. */}
      <div className={cn("absolute inset-4 border", tone.line)} aria-hidden="true" />
      <span className="absolute top-4 left-4 h-3 w-3 border-t border-l border-m-oro" aria-hidden="true" />
      <span className="absolute right-4 bottom-4 h-3 w-3 border-r border-b border-m-oro" aria-hidden="true" />

      <div className={cn("absolute inset-0 flex flex-col justify-end gap-2 p-8", tone.ink)}>
        <p className="m-eyebrow opacity-70">Fotografía pendiente</p>
        <p className="max-w-[42ch] text-sm leading-relaxed">{slot.brief}</p>
      </div>
    </div>
  );
}
