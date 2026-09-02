# MOMPOSINA · landing

Sitio de una sola página para **Momposina** (hoy *La Momposina*), joyería en
Zaragoza, Antioquia.

> **No es parte de la aplicación Octopush.** Vive en este repositorio pero es
> un proyecto independiente, con su propio `package.json`, su propio sistema
> visual y su propio build. No comparte tokens, componentes ni dependencias
> con `src/`, y no aparece en `docs/FEATURES.md` porque no es una función del
> producto Octopush.

---

## Correr y publicar

```bash
cd momposina
npm install
npm run dev        # servidor de desarrollo en :4321
npm run typecheck  # TypeScript
npm run build      # dist/ listo para publicar
npm run preview    # sirve dist/ como en producción
```

`npm run build` hace tres cosas: compila el cliente, compila un bundle de
servidor y **prerenderiza** la página dentro de `dist/index.html`. El
resultado es HTML completo antes de que cargue el JavaScript — importa para
buscadores, para la vista previa del enlace en WhatsApp y para el tiempo de
primer pintado en un teléfono con mala señal. La página se hidrata después
para el menú y los revelados.

`dist/` es estático: sirve en cualquier hosting (Netlify, Vercel, Cloudflare
Pages, un bucket). No necesita servidor.

---

## Qué hay que reemplazar

Todo lo editable está en `src/content/`. Ningún componente tiene texto
quemado.

| Archivo | Qué contiene |
|---|---|
| `brand.ts` | Nombre, descriptor, territorio, año de fundación, metadatos SEO |
| `contact.ts` | WhatsApp, Instagram, correo, horario, dirección |
| `content.ts` | Todo el texto de la página, sección por sección |
| `products.ts` | Las seis piezas de la selección |
| `media.ts` | Los huecos de fotografía |

### Los corchetes son deliberados

Lo que se ve así — `[Nombre del joyero]`, `[Ley]`, `[Horario de atención]` —
es información que todavía no tenemos. Se muestra como una casilla por
diligenciar (`<Pendiente/>`), no como texto normal. **No se rellenan
inventando**: se reemplaza el valor en el archivo correspondiente y el
subrayado punteado desaparece solo.

Pendientes hoy: nombres de las tres personas del taller y sus tiempos de
oficio, número de WhatsApp real (`contact.whatsapp.phone`), usuario de
Instagram, correo, horario, dirección, año de fundación, y nombre / ley /
peso / precio de cada pieza.

### Fotografía

No hay material fotográfico todavía, y el diseño **no** está construido sobre
imágenes de banco. Cada imagen es un slot en `media.ts` con el encuadre que
hay que hacer:

```ts
hero: slot({
  src: "/fotos/hero.jpg",   // ← poner la ruta
  alt: "Manos sosteniendo una cadena terminada",
  brief: "Plano cinematográfico…",
  ratio: "3 / 2",
  tone: "carbon",
}),
```

Con `src` en `null` se pinta la plancha mineral con la indicación del
encuadre; con `src` puesto se imprime la foto —diferida, con la misma
proporción, así que el layout no salta—. Las piezas llevan su propio slot
dentro de `products.ts`.

Formato recomendado: WebP o AVIF, lado largo 2000 px, y el `alt` escrito de
verdad (no el `brief`).

### Antes de publicar

- `seo.siteUrl` en `brand.ts` y las URL absolutas de `index.html` apuntan a
  `momposina.co`. Cambiarlas si el dominio es otro.
- **`public/og.svg` es un provisional.** Las redes sociales no renderizan SVG
  en las tarjetas: hay que reemplazarlo por un **JPG de 1200×630** con
  fotografía real y actualizar las etiquetas `og:image` / `twitter:image`.

---

## Una regla que no es de diseño

La marca puede decir que nació en una tierra cuya historia está atada al oro,
y que la familia lo conoció por la minería artesanal. **No puede decir que el
oro de una pieza salga de aquí**, ni llamarlo sostenible, ético, responsable
o certificado, mientras no exista trazabilidad que lo demuestre. La sección
Origen lo dice explícitamente y esa nota es parte de la identidad, no un
descargo legal. Si algún día hay trazabilidad, se documenta ahí — con nombre
y con papel.

---

## Sistema visual

**Atelier mineral.** El fondo es hueso, la tinta es tierra oscura y el oro
aparece poco. La regla de fondo: *el amarillo lo pone la joya, no la
interfaz* — cuando lleguen las fotografías reales, el oro va a ser el color
más saturado de la pantalla sin que la interfaz compita.

- **Color** — tokens `--color-m-*` en `src/styles.css`. Hueso (`crudo`,
  `papel`), carbón cálido, y tres oros con trabajos distintos: `oro` sobre
  oscuro, `oro-tierra` sobre claro (el único que pasa AA como texto),
  `oro-alto` para hover. Nada de hexadecimales fuera de ese archivo.
- **Tipografía** — Fraunces (con los ejes `SOFT` y `WONK`, que son el rasgo
  tipográfico de la marca) para los momentos; Archivo para cuerpo y meta.
  Autoalojadas: sin petición a un CDN de terceros. Las versalitas espaciadas
  y las cifras tabulares vienen del libro de ley y peso del oro.
- **Movimiento** — tres primitivas (`.m-reveal`, `.m-rule`, `.m-link`), una
  curva, tres duraciones. Nada rebota, nada aparece de golpe, nada secuestra
  el scroll. Todo respeta `prefers-reduced-motion`, y sin JavaScript el
  contenido se ve igual.
- **Los tres momentos oscuros** son el hero, Transformación y el cierre
  (Manifiesto + Contacto + pie). Si se agrega un cuarto, dejan de ser
  momentos.
- **Sin bordes redondeados, sin degradados como filete, sin coronas, sin
  diamantes genéricos, sin emojis.** El rectángulo es una decisión.

## Estructura

```
src/
  content/     texto, productos, contacto, marca, fotografía  ← lo editable
  components/  primitivas (Plate, Reveal, Rule, Cta, Pendiente, Mark)
    layout/    header, footer, rejilla de sección
    sections/  las nueve secciones, en el orden en que se leen
  hooks/       useReveal, useActiveIndex
  lib/         cn, formato de precio
```
