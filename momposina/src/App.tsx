import { SiteFooter } from "./components/layout/SiteFooter";
import { SiteHeader } from "./components/layout/SiteHeader";
import { Contacto } from "./components/sections/Contacto";
import { HechoParaTi } from "./components/sections/HechoParaTi";
import { Hero } from "./components/sections/Hero";
import { Lenguaje } from "./components/sections/Lenguaje";
import { Manifiesto } from "./components/sections/Manifiesto";
import { Oficio } from "./components/sections/Oficio";
import { Origen } from "./components/sections/Origen";
import { Piezas } from "./components/sections/Piezas";
import { Transformacion } from "./components/sections/Transformacion";

/**
 * La página es una narración vertical, no una lista de bloques.
 *
 *   carbón   Hero              — el nombre y una sola línea
 *   hueso    Origen            — el oro como trabajo, y qué podemos afirmar
 *   carbón   Transformación    — materia · fuego · manos · forma · pieza
 *   papel    Oficio            — tres generaciones, en orden
 *   hueso    Lenguaje          — por qué estas joyas se ven
 *   hueso    Piezas            — una selección, no un catálogo
 *   papel    Hecho para ti     — transformar lo que ya se tiene
 *   carbón   Manifiesto        — la posición, en cinco líneas
 *   carbón   Contacto + pie    — cierra donde abrió
 *
 * Los tres bloques oscuros son los tres momentos. Si algún día se agrega un
 * cuarto, deja de haber momentos.
 */
export default function App() {
  return (
    <>
      <a
        href="#origen"
        className="m-eyebrow sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[70] focus:bg-m-tinta focus:px-5 focus:py-3 focus:text-m-papel"
      >
        Saltar al contenido
      </a>

      <SiteHeader />

      <main>
        <Hero />
        <Origen />
        <Transformacion />
        <Oficio />
        <Lenguaje />
        <Piezas />
        <HechoParaTi />
        <Manifiesto />
        <Contacto />
      </main>

      <SiteFooter />
    </>
  );
}
