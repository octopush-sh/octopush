import { origen } from "../../content/content";
import { media } from "../../content/media";
import { Eyebrow } from "../Eyebrow";
import { Plate } from "../Plate";
import { Reveal } from "../Reveal";
import { Rule } from "../Rule";
import { Section, Spread } from "../layout/Section";

/**
 * Origen.
 *
 * Acá se separan dos cosas que casi todas las marcas de joyería mezclan sin
 * pudor: la historia de la familia con el oro, y la procedencia del oro de
 * cada pieza. La nota final dice exactamente qué podemos sostener hoy.
 */
export function Origen() {
  return (
    <Section id="origen" surface="crudo" labelledBy="origen-titulo" className="py-24 md:py-36">
      <Spread>
        <div className="md:col-span-5">
          <Reveal>
            <Eyebrow index={origen.index} className="text-m-oro-tierra">
              {origen.eyebrow}
            </Eyebrow>
          </Reveal>
          <Reveal>
            <h2
              id="origen-titulo"
              className="m-display mt-8 text-[clamp(2rem,5.5vw,3.4rem)] text-balance"
            >
              {origen.title}
            </h2>
          </Reveal>
          <Rule className="mt-10 text-m-oro-tierra" />

          <Reveal className="mt-10">
            <Plate slot={media.origenMaterial} sizes="(min-width: 768px) 38vw, 100vw" />
          </Reveal>
        </div>

        <div className="md:col-span-6 md:col-start-7">
          <div className="m-stagger max-w-[52ch]">
            {origen.paragraphs.map((paragraph, index) => (
              <Reveal
                as="p"
                key={paragraph}
                index={index}
                className="mt-6 text-lg leading-relaxed text-m-humo first:mt-0"
              >
                {paragraph}
              </Reveal>
            ))}
          </div>

          {/* La nota de honestidad. Es la pieza de identidad más importante
              de esta sección: dice qué no sabemos todavía. */}
          <Reveal className="mt-14 border-l border-m-oro-tierra bg-m-papel p-8">
            <p className="m-eyebrow text-m-oro-tierra">{origen.note.title}</p>
            <div className="mt-5 max-w-[54ch] space-y-4 text-[0.95rem] leading-relaxed text-m-humo">
              {origen.note.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </Reveal>

          <Reveal className="mt-12">
            <Plate slot={media.origenTerritorio} sizes="(min-width: 768px) 46vw, 100vw" />
          </Reveal>
        </div>
      </Spread>
    </Section>
  );
}
