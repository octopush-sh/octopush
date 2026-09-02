/**
 * Catálogo editorial. Seis piezas, no un catálogo completo.
 *
 * Nada acá está inventado: los nombres, las leyes, los pesos y los precios
 * son placeholders hasta que el taller los suministre. `price: null` se
 * muestra como "Precio a consultar", que hoy es la verdad.
 *
 * Esta forma de datos ya está lista para venir de un CMS o de una tienda:
 * cambiar el origen de `products` no debería tocar ningún componente.
 */

import { slot, type PhotoSlot } from "./media";
import { pendiente } from "./brand";

export type Product = {
  id: string;
  /** Número de ficha. Es parte de la identidad visual, no un SKU. */
  ref: string;
  name: string;
  /** Tipo de pieza. Vocabulario de acá: candongas, esclava, sello. */
  type: string;
  /** Ley del oro. Pendiente: no la afirmamos sin confirmarla. */
  karat: string;
  /** Peso en gramos. En esta joyería el peso es información, no un detalle. */
  weight: string;
  /** Precio en pesos colombianos. `null` mientras no exista lista de precios. */
  price: number | null;
  /** Una línea. Qué es la pieza, sin adjetivos de folleto. */
  line: string;
  photo: PhotoSlot;
};

export const products: Product[] = [
  {
    id: "cadena-eslabon",
    ref: "01",
    name: pendiente("Nombre de pieza"),
    type: "Cadena, eslabón grueso",
    karat: pendiente("Ley"),
    weight: pendiente("Peso"),
    price: null,
    line: "Eslabón cerrado y soldado uno por uno. Se hizo para verse.",
    photo: slot({
      alt: "",
      brief: "Cadena colgando en vertical, luz dura lateral, fondo neutro.",
      ratio: "3 / 4",
      tone: "carbon",
    }),
  },
  {
    id: "anillo-sello",
    ref: "02",
    name: pendiente("Nombre de pieza"),
    type: "Anillo de sello",
    karat: pendiente("Ley"),
    weight: pendiente("Peso"),
    price: null,
    line: "Cuerpo ancho, cara plana. Se puede grabar.",
    photo: slot({
      alt: "",
      brief: "Anillo de tres cuartos, sombra propia marcada, sin reflejo de estudio.",
      ratio: "3 / 4",
      tone: "tierra",
    }),
  },
  {
    id: "candongas",
    ref: "03",
    name: pendiente("Nombre de pieza"),
    type: "Candongas",
    karat: pendiente("Ley"),
    weight: pendiente("Peso"),
    price: null,
    line: "Diámetro grande, tubo liviano. Presencia sin peso en la oreja.",
    photo: slot({
      alt: "",
      brief: "Par de candongas puestas, perfil de la persona, luz natural.",
      ratio: "3 / 4",
      tone: "mineral",
    }),
  },
  {
    id: "esclava",
    ref: "04",
    name: pendiente("Nombre de pieza"),
    type: "Esclava",
    karat: pendiente("Ley"),
    weight: pendiente("Peso"),
    price: null,
    line: "Placa para grabar nombre o fecha. La pieza más pedida para regalar.",
    photo: slot({
      alt: "",
      brief: "Esclava sobre muñeca real, apoyada, con el grabado legible.",
      ratio: "3 / 4",
      tone: "piedra",
    }),
  },
  {
    id: "dije",
    ref: "05",
    name: pendiente("Nombre de pieza"),
    type: "Dije",
    karat: pendiente("Ley"),
    weight: pendiente("Peso"),
    price: null,
    line: "Se hace por encargo. Casi siempre nace de algo que alguien ya tenía.",
    photo: slot({
      alt: "",
      brief: "Macro del dije, textura del metal a la vista, sin retoque que borre el trabajo.",
      ratio: "3 / 4",
      tone: "oro",
    }),
  },
  {
    id: "pulsera",
    ref: "06",
    name: pendiente("Nombre de pieza"),
    type: "Pulsera de eslabón",
    karat: pendiente("Ley"),
    weight: pendiente("Peso"),
    price: null,
    line: "El mismo eslabón de la cadena, en otra escala.",
    photo: slot({
      alt: "",
      brief: "Pulsera enrollada sobre superficie de piedra o madera vieja.",
      ratio: "3 / 4",
      tone: "carbon",
    }),
  },
];
