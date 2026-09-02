/**
 * Identidad de marca. Todo lo que define "quién es" MOMPOSINA vive aquí.
 *
 * Los valores entre corchetes — [Año de fundación], [Nombre del joyero] — son
 * PLACEHOLDERS: información real que todavía no tenemos. Se muestran en la
 * interfaz con un estilo propio (ver <Placeholder/>) para que nunca se
 * confundan con contenido definitivo. Reemplazarlos aquí basta.
 */

export const PLACEHOLDER_PREFIX = "[";

/** Marca un valor como pendiente de suministrar. */
export const pendiente = (etiqueta: string) => `[${etiqueta}]`;

export const brand = {
  /** Nombre corto — el que usamos en toda la página. */
  name: "MOMPOSINA",
  /** Nombre legal / histórico del negocio. Aparece solo en el pie. */
  legalName: "La Momposina",
  /** Bajada del logotipo. */
  descriptor: "Joyería",
  /** Territorio. Nunca lo escondemos, nunca lo convertimos en folclor. */
  place: {
    town: "Zaragoza",
    region: "Antioquia",
    country: "Colombia",
    /** Subregión — contexto para quien no ubica el municipio. */
    subregion: "Bajo Cauca",
    short: "Zaragoza · Antioquia",
    full: "Zaragoza, Antioquia, Colombia",
  },
  /**
   * Lema provisional. Nace del relato: el oro fue trabajo antes que joya.
   * No es definitivo — se decide con la marca, no con la web.
   */
  taglineProvisional: "El oro aquí se conoce desde antes",
  /** Año en que el negocio empezó. Pendiente de confirmar. */
  foundedYear: pendiente("Año de fundación"),
} as const;

export const seo = {
  title: "Momposina · Joyería en Zaragoza, Antioquia",
  description:
    "Joyería hecha a mano en Zaragoza, Antioquia. Piezas en oro con presencia y carácter, y transformación de oro o joyas propias en un diseño nuevo.",
  /** Se usa como canonical y en los metadatos sociales. */
  siteUrl: "https://momposina.co",
  /** Imagen social. Reemplazar por una fotografía real cuando exista. */
  ogImage: "/og.svg",
  locale: "es_CO",
} as const;
