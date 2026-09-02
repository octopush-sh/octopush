import { brand, seo } from "../content/brand";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Metadatos del documento, construidos desde `content/brand.ts`.
 *
 * Se inyectan en el HTML durante el build (ver scripts/prerender.mjs) para
 * que el título, la descripción, la tarjeta social y el schema.org salgan de
 * un solo sitio: cambiar el dominio o la descripción es tocar un archivo, no
 * cuatro etiquetas repetidas a mano.
 */
export const documentTitle = () => seo.title;

export function head(): string {
  const url = seo.siteUrl.endsWith("/") ? seo.siteUrl : `${seo.siteUrl}/`;
  const image = `${url.slice(0, -1)}${seo.ogImage}`;
  const social = `${brand.taglineProvisional}. Joyería hecha a mano en ${brand.place.town}, ${brand.place.region}.`;

  const schema = {
    "@context": "https://schema.org",
    "@type": "JewelryStore",
    name: brand.name,
    alternateName: brand.legalName,
    description: seo.description,
    url,
    image,
    address: {
      "@type": "PostalAddress",
      addressLocality: brand.place.town,
      addressRegion: brand.place.region,
      addressCountry: "CO",
    },
    areaServed: { "@type": "AdministrativeArea", name: `${brand.place.region}, ${brand.place.country}` },
    knowsLanguage: "es-CO",
  };

  return [
    `<meta name="description" content="${escape(seo.description)}" />`,
    `<link rel="canonical" href="${escape(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${escape(brand.name)}" />`,
    `<meta property="og:locale" content="${seo.locale}" />`,
    `<meta property="og:title" content="${escape(seo.title)}" />`,
    `<meta property="og:description" content="${escape(social)}" />`,
    `<meta property="og:url" content="${escape(url)}" />`,
    `<meta property="og:image" content="${escape(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(seo.title)}" />`,
    `<meta name="twitter:description" content="${escape(social)}" />`,
    `<meta name="twitter:image" content="${escape(image)}" />`,
    `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>`,
  ].join("\n    ");
}
