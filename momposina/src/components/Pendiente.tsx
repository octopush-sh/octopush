import { cn } from "../lib/cn";

/**
 * Un valor que todavía no tenemos.
 *
 * La página no rellena huecos con datos inventados: los muestra como lo que
 * son, una casilla por diligenciar. En cuanto el valor deja de venir entre
 * corchetes, esto se imprime como texto normal sin tocar nada.
 */
export function Pendiente({ value, className }: { value: string; className?: string }) {
  const isPending = value.startsWith("[") && value.endsWith("]");
  if (!isPending) return <>{value}</>;
  return (
    <span className={cn("m-pendiente", className)} title="Información pendiente de suministrar">
      {value}
    </span>
  );
}
