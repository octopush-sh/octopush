import { manifiesto } from "../../content/content";
import { Eyebrow } from "../Eyebrow";
import { Reveal } from "../Reveal";
import { Rule } from "../Rule";

/**
 * Manifiesto.
 *
 * Cinco líneas y un remate seco. Nada de sentimentalismo: la posición de la
 * marca cabe en una respiración por renglón.
 */
export function Manifiesto() {
  return (
    <section
      id="manifiesto"
      aria-labelledby="manifiesto-titulo"
      className="on-dark bg-m-carbon text-m-crema"
    >
      <div className="mx-auto w-full max-w-[78rem] px-6 py-24 md:px-10 md:py-40">
        <Reveal>
          <Eyebrow className="text-m-oro">
            <span id="manifiesto-titulo">{manifiesto.eyebrow}</span>
          </Eyebrow>
        </Reveal>

        <Rule className="mt-8 max-w-[12rem] text-m-oro" />

        <div className="m-stagger mt-12 md:mt-16">
          {manifiesto.lines.map((line, index) => (
            <Reveal
              as="p"
              key={line}
              index={index}
              className="m-serif mt-6 max-w-[26ch] text-[clamp(1.6rem,4.6vw,2.9rem)] leading-[1.25] text-balance first:mt-0"
            >
              {line}
            </Reveal>
          ))}
        </div>

        <Reveal as="p" className="m-eyebrow mt-14 text-m-ceniza">
          {manifiesto.closing}
        </Reveal>
      </div>
    </section>
  );
}
