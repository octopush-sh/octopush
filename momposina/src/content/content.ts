/**
 * Todo el texto de la página, en un solo archivo.
 *
 * Reglas de escritura que conviene respetar al editar:
 *  · Español colombiano neutro. Frases cortas. Ritmo antes que adorno.
 *  · No se afirma nada que no podamos sostener. Lo que no sabemos va como
 *    placeholder entre corchetes, nunca como relleno inventado.
 *  · Palabras prohibidas por gastadas: lujo, exclusivo, único, premium,
 *    excelencia, pasión, tradición, elegancia.
 */

import { pendiente } from "./brand";

export type NavLink = { label: string; href: string };

export const nav: NavLink[] = [
  { label: "Origen", href: "#origen" },
  { label: "Oficio", href: "#oficio" },
  { label: "Lenguaje", href: "#lenguaje" },
  { label: "Piezas", href: "#piezas" },
  { label: "Hecho para ti", href: "#hecho-para-ti" },
  { label: "Contacto", href: "#contacto" },
];

export const hero = {
  eyebrow: "Zaragoza · Antioquia · Colombia",
  /** Una sola línea. Debe abrir curiosidad, no explicar. */
  line: "Aquí el oro se conoce desde antes de ser joya.",
  primaryCta: "Escribir por WhatsApp",
  primaryCtaMessage:
    "Hola, los vi en la página de Momposina y quiero preguntarles por una pieza.",
  secondaryCta: "Ver las piezas",
  scrollHint: "Baje",
} as const;

export const origen = {
  index: "01",
  eyebrow: "Origen",
  title: "El oro llegó primero como trabajo",
  paragraphs: [
    "Zaragoza queda en el Bajo Cauca antioqueño. Es un municipio donde el oro no es una idea: es una historia larga y cotidiana, con todo lo que eso implica.",
    "En esta familia el oro entró por el trabajo. Barequeo. Recorrer terreno. Romper y moler piedra. Días enteros para recuperar unos gramos.",
    "Ese oro no se volvía joya. Se volvía comida, cuadernos, techo. Era sustento.",
    "Hoy hay un taller y hay banco de trabajo. El mismo metal empieza a volverse también forma.",
  ],
  note: {
    title: "Lo que sí podemos afirmar",
    paragraphs: [
      "Nuestra historia con el oro es familiar y territorial, y viene de la minería artesanal. No venimos de una casa joyera heredada y no vamos a inventarnos una.",
      "El oro con el que se trabaja hoy no lo podemos seguir hasta una mina concreta. Mientras no exista esa trazabilidad, no vamos a decir que una pieza salió de esta tierra, ni que es sostenible, ni que está certificada.",
      "El día que podamos documentarlo, va a estar escrito en esta misma página, con nombre y con papel.",
    ],
  },
} as const;

export const transformacion = {
  index: "02",
  eyebrow: "Transformación",
  title: "Cinco estados del mismo metal",
  beats: [
    {
      n: "01",
      word: "Materia",
      line: "Antes de brillar, el oro es peso. Se pesa, se calcula, se decide qué alcanza.",
      media: "materia",
    },
    {
      n: "02",
      word: "Fuego",
      line: "A 1064 °C deja de ser lo que era. De ahí no se devuelve.",
      media: "fuego",
    },
    {
      n: "03",
      word: "Manos",
      line: "Lo que sigue se mide en horas y en pulso. Lima, martillo, paciencia.",
      media: "manos",
    },
    {
      n: "04",
      word: "Forma",
      line: "La forma existe en la cabeza antes que en el metal. El metal apenas obedece.",
      media: "forma",
    },
    {
      n: "05",
      word: "Pieza",
      line: "Sale del taller cuando ya no es material: ya es de alguien.",
      media: "pieza",
    },
  ],
  /** El remate a dos tiempos. Es el momento central de la página. */
  close: {
    before: "Antes fue sustento.",
    after: "Hoy también es símbolo.",
  },
} as const;

export const oficio = {
  index: "03",
  eyebrow: "El oficio",
  title: "Quién hace las piezas",
  lead: "No heredamos un oficio joyero: lo estamos empezando. Lo viejo acá es la relación con el oro. El taller es lo nuevo.",
  people: [
    {
      name: pendiente("Nombre del padre"),
      role: "Minería artesanal",
      generation: "Antes",
      line: "Dedicó buena parte de su vida a buscar oro con las manos. Nunca hizo joyas: hizo posible que alguien después pudiera hacerlas.",
      meta: pendiente("Años en la minería"),
      media: "oficioMinero",
    },
    {
      name: pendiente("Nombre del joyero"),
      role: "Joyero",
      generation: "Hoy",
      line: "Es el yerno de la casa y es quien fabrica. Todo lo que sale del taller pasa por sus manos.",
      meta: pendiente("Años en el oficio"),
      media: "oficioJoyero",
    },
    {
      name: pendiente("Nombre del aprendiz"),
      role: "Aprendiz",
      generation: "Después",
      line: "Su hijo. Está aprendiendo el oficio y ya tiene mano propia. La siguiente generación no llega: ya está en el banco.",
      meta: pendiente("Tiempo aprendiendo"),
      media: "oficioAprendiz",
    },
  ],
} as const;

export const lenguaje = {
  index: "04",
  eyebrow: "Nuestro lenguaje",
  titleQuiet: "Hay joyas que susurran.",
  titleLoud: "Estas no.",
  paragraphs: [
    "El gusto de esta región tiene reglas propias: cadena con cuerpo, anillo que se siente en la mano, oro bien amarillo, pieza que se ve de lejos.",
    "Durante años eso se contó como falta de refinamiento, medido contra un catálogo europeo que nunca fue de acá. Hay clientes que funden joyas de marca internacional para convertirlas en algo más parecido a lo suyo. Eso no es un defecto de gusto: es una preferencia con criterio.",
    "Nuestro trabajo no es corregir ese lenguaje. Es depurarlo. La misma fuerza, mejor ejecución: proporción pensada, soldadura limpia, terminación pareja, peso donde tiene que estar.",
  ],
  traits: [
    { label: "Presencia", line: "Se diseña para que se vea, no para desaparecer sobre el cuerpo." },
    { label: "Volumen", line: "El peso es parte del diseño, no un exceso que haya que disculpar." },
    { label: "Amarillo", line: "El color del oro no se apaga para que combine con todo." },
    { label: "Mano", line: "Hecho a mano, con las marcas que eso deja cuando está bien hecho." },
    { label: "Terminación", line: "Que sea artesanal no es excusa para una lima floja." },
  ],
} as const;

export const piezas = {
  index: "05",
  eyebrow: "Piezas",
  title: "Una selección",
  lead: "Esto no es el catálogo completo: es una muestra de lo que sale del taller. La disponibilidad se confirma por mensaje, y casi todo se puede hacer por encargo.",
  note: "Nombres, medidas y precios entre corchetes están pendientes. No inventamos fichas de producto.",
  cta: "Preguntar por una pieza",
  ctaMessage: "Hola, quiero preguntar por una de las piezas que vi en la página.",
} as const;

export const hechoParaTi = {
  index: "06",
  eyebrow: "Hecho para ti",
  title: "Lo que ya tienes puede tomar otra forma",
  paragraphs: [
    "Mucha gente llega con algo en la mano: una cadena partida, unos aretes que ya no se ponen, una pieza heredada que no se usa pero tampoco se vende, oro guardado hace años.",
    "No siempre hay que empezar de cero. Con frecuencia se puede trabajar sobre lo que ya existe.",
  ],
  steps: [
    { n: "01", title: "Conversamos", line: "Nos cuenta qué tiene y qué quiere. Unas fotos por WhatsApp bastan para empezar." },
    { n: "02", title: "Evaluamos", line: "Revisamos el material en el taller: ley, estado, soldaduras viejas, cuánto rinde de verdad." },
    { n: "03", title: "Diseñamos", line: "Definimos la pieza: tipo, peso, proporción. Antes de tocar el metal usted ya sabe qué va a recibir." },
    { n: "04", title: "Transformamos", line: "Fundición, forma, terminación. El proceso lo puede ir viendo." },
    { n: "05", title: "Entregamos", line: "Se entrega en Zaragoza o se envía. Eso se acuerda desde el principio." },
  ],
  note: "No todo material se puede reutilizar tal cual. La aleación, las soldaduras y el estado de la pieza definen qué es posible: eso se revisa antes de prometer nada.",
  cta: "Contar qué tengo",
  ctaMessage: "Hola, tengo una joya u oro que quisiera transformar. ¿Lo podemos revisar?",
} as const;

export const manifiesto = {
  eyebrow: "Manifiesto",
  lines: [
    "Conocimos el oro trabajando, no comprándolo.",
    "Lo vimos como peso mucho antes que como brillo.",
    "Hacemos joyas que se notan, porque acá las joyas se hacen para notarse.",
    "No queremos parecernos a una casa europea.",
    "Queremos que lo de acá esté bien hecho.",
  ],
  closing: "Ese es el programa completo.",
} as const;

export const contacto = {
  index: "07",
  eyebrow: "Contacto",
  title: "Hablemos",
  lead: "Todavía no hay carrito. Hay una conversación, que es como se ha hecho siempre acá.",
  primaryCta: "Escribir por WhatsApp",
  primaryCtaMessage: "Hola, quiero hablar con Momposina.",
  designCta: "Diseñar una pieza",
  designCtaMessage: "Hola, quiero mandar a hacer una pieza. Les cuento qué tengo en mente.",
  instagramCta: "Ver el Instagram",
} as const;

export const footer = {
  line: "Antes sustento. Hoy también forma.",
  rights: "Todos los derechos reservados.",
} as const;
