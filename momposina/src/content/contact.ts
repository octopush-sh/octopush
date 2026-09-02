/**
 * Canales de contacto. Un solo sitio para cambiar teléfono, redes y textos
 * de los botones. La mayor parte del tráfico llega de Instagram y termina en
 * WhatsApp: ese es el embudo real, no un checkout.
 */

import { pendiente } from "./brand";

export const contact = {
  whatsapp: {
    /** Solo dígitos, con indicativo país. 57 = Colombia. */
    phone: "573000000000",
    /** Cómo se muestra el número si alguna vez lo imprimimos. */
    display: pendiente("WhatsApp"),
    /** Mensaje con el que se abre el chat. Cada CTA puede sobreescribirlo. */
    defaultMessage:
      "Hola, los vi en la página de Momposina y quiero preguntarles por una pieza.",
    configured: false,
  },
  instagram: {
    handle: pendiente("Instagram"),
    url: "https://instagram.com/",
    configured: false,
  },
  email: {
    address: pendiente("Correo"),
    configured: false,
  },
  /** Atención: horarios y modo. Pendiente de confirmar con el taller. */
  hours: pendiente("Horario de atención"),
  /** Dirección exacta del taller: no se publica hasta que se confirme. */
  address: pendiente("Dirección del taller"),
} as const;

/** Construye el enlace de WhatsApp con un mensaje contextual. */
export function whatsappUrl(message: string = contact.whatsapp.defaultMessage) {
  return `https://wa.me/${contact.whatsapp.phone}?text=${encodeURIComponent(message)}`;
}
