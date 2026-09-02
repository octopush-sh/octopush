/**
 * Slots de fotografía.
 *
 * Todavía no existe el material fotográfico de la marca, y construir el diseño
 * sobre imágenes de stock lo habría condenado a parecerse a cualquier otra
 * joyería. Así que cada imagen de la página es un SLOT: un bloque mineral con
 * grano y la indicación del encuadre que falta.
 *
 * Para publicar una foto real: pon su ruta en `src` (y su `alt` definitivo).
 * El componente <Plate/> cambia solo — nada más hay que tocar.
 */

export type PlateTone = "carbon" | "mineral" | "tierra" | "piedra" | "oro";

export type PhotoSlot = {
  /** Ruta de la fotografía. `null` mientras no exista. */
  src: string | null;
  /** Texto alternativo. Obligatorio cuando `src` deja de ser null. */
  alt: string;
  /** El encuadre que hay que fotografiar. Se muestra dentro del placeholder. */
  brief: string;
  /** Proporción del hueco, para que el layout no salte al llegar la foto. */
  ratio: string;
  tone: PlateTone;
};

export const slot = (s: Omit<PhotoSlot, "src"> & { src?: string | null }): PhotoSlot => ({
  src: null,
  ...s,
});

export const media = {
  hero: slot({
    alt: "",
    brief: "Plano cinematográfico. Manos sosteniendo una pieza terminada, luz lateral, fondo oscuro.",
    ratio: "3 / 2",
    tone: "carbon",
  }),
  origenTerritorio: slot({
    alt: "",
    brief: "Paisaje del Bajo Cauca al final de la tarde. Puntual, sin postal turística.",
    ratio: "4 / 5",
    tone: "mineral",
  }),
  origenMaterial: slot({
    alt: "",
    brief: "Macro: material aurífero en bruto sobre la palma de una mano.",
    ratio: "1 / 1",
    tone: "tierra",
  }),
  materia: slot({
    alt: "",
    brief: "Retazos de metal antes de fundir, sobre la mesa del taller.",
    ratio: "4 / 3",
    tone: "piedra",
  }),
  fuego: slot({
    alt: "",
    brief: "Soplete sobre el crisol. Metal al rojo. Sin dramatizar la llama.",
    ratio: "4 / 3",
    tone: "oro",
  }),
  manos: slot({
    alt: "",
    brief: "Manos limando. Uñas reales, callos reales, herramienta gastada.",
    ratio: "4 / 3",
    tone: "carbon",
  }),
  forma: slot({
    alt: "",
    brief: "Pieza a medio hacer sujeta en el banco. Todavía mate, todavía sin pulir.",
    ratio: "4 / 3",
    tone: "mineral",
  }),
  pieza: slot({
    alt: "",
    brief: "Pieza terminada, fondo limpio, luz que muestre el amarillo real del oro.",
    ratio: "4 / 3",
    tone: "tierra",
  }),
  oficioMinero: slot({
    alt: "",
    brief: "Manos mayores, marcadas por el trabajo. Sin herramienta de joyería: es otra historia.",
    ratio: "3 / 4",
    tone: "tierra",
  }),
  oficioJoyero: slot({
    alt: "",
    brief: "Retrato del joyero en el banco de trabajo. Mirada al oficio, no a la cámara.",
    ratio: "3 / 4",
    tone: "carbon",
  }),
  oficioAprendiz: slot({
    alt: "",
    brief: "Retrato de la siguiente generación aprendiendo. Dos manos, dos edades.",
    ratio: "3 / 4",
    tone: "mineral",
  }),
  lenguajeMacro: slot({
    alt: "",
    brief: "Macro extremo de eslabón grueso. Que se vea el peso y el trabajo de soldadura.",
    ratio: "1 / 1",
    tone: "oro",
  }),
  lenguajeCuerpo: slot({
    alt: "",
    brief: "Pieza puesta sobre piel real, en luz natural. Persona de la región, no modelo.",
    ratio: "4 / 5",
    tone: "tierra",
  }),
  hechoParaTi: slot({
    alt: "",
    brief: "Joyas viejas del cliente en una bandeja, antes de transformarse.",
    ratio: "16 / 9",
    tone: "piedra",
  }),
} satisfies Record<string, PhotoSlot>;

export type MediaKey = keyof typeof media;
