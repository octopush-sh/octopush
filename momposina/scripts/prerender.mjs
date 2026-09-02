/**
 * Inyecta el HTML renderizado dentro de dist/index.html.
 *
 * Se ejecuta después de los dos `vite build` (cliente y SSR). El resultado es
 * un sitio estático que se ve completo antes de que cargue el JavaScript, y
 * que se hidrata después para el menú y los revelados.
 */
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");
const ssr = path.join(here, "..", "dist-ssr");

const { render, head, documentTitle } = await import(path.join(ssr, "entry-server.js"));
const html = await readFile(path.join(dist, "index.html"), "utf8");

const marker = '<div id="root"></div>';
const seoMarker = "<!--seo-->";
if (!html.includes(marker)) {
  throw new Error("No se encontró el contenedor #root en dist/index.html");
}
if (!html.includes(seoMarker)) {
  throw new Error("No se encontró el marcador <!--seo--> en dist/index.html");
}

await writeFile(
  path.join(dist, "index.html"),
  html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${documentTitle()}</title>`)
    .replace(seoMarker, head())
    .replace(marker, `<div id="root">${render()}</div>`),
  "utf8",
);

await rm(ssr, { recursive: true, force: true });
console.log("prerender · dist/index.html contiene el HTML completo");
