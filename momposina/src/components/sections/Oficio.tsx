import { oficio } from "../../content/content";
import { media, type MediaKey } from "../../content/media";
import { Eyebrow } from "../Eyebrow";
import { Pendiente } from "../Pendiente";
import { Plate } from "../Plate";
import { Reveal } from "../Reveal";
import { Section, Spread } from "../layout/Section";

/**
 * El oficio, en tres generaciones.
 *
 * El orden importa: primero el que buscó el oro y nunca hizo una joya,
 * después el que fabrica, después el que está aprendiendo. Así queda claro
 * que la línea familiar es con el metal, no con la joyería.
 *
 * Ningún nombre, ninguna cifra y ninguna biografía están inventados: lo que
 * falta se muestra entre corchetes hasta que el taller lo suministre.
 */
export function Oficio() {
  return (
    <Section id="oficio" surface="papel" labelledBy="oficio-titulo" className="py-24 md:py-36">
      <Spread className="items-end">
        <div className="md:col-span-7">
          <Reveal>
            <Eyebrow index={oficio.index} className="text-m-oro-tierra">
              {oficio.eyebrow}
            </Eyebrow>
          </Reveal>
          <Reveal>
            <h2 id="oficio-titulo" className="m-display mt-8 text-[clamp(2rem,5.5vw,3.4rem)]">
              {oficio.title}
            </h2>
          </Reveal>
        </div>
        <Reveal as="p" className="md:col-span-5 max-w-[42ch] text-lg leading-relaxed text-m-humo">
          {oficio.lead}
        </Reveal>
      </Spread>

      <ol className="m-stagger mt-16 grid grid-cols-1 gap-10 sm:grid-cols-2 md:mt-24 md:grid-cols-3 md:gap-8">
        {oficio.people.map((person, index) => (
          <Reveal as="li" key={person.role} index={index}>
            <Plate
              slot={media[person.media as MediaKey]}
              sizes="(min-width: 768px) 30vw, (min-width: 640px) 46vw, 100vw"
            />
            <p className="m-eyebrow mt-6 text-m-oro-tierra">{person.generation}</p>
            <h3 className="m-display mt-3 text-2xl">
              <Pendiente value={person.name} />
            </h3>
            <p className="m-eyebrow mt-2 text-m-humo">{person.role}</p>
            <p className="mt-4 max-w-[36ch] leading-relaxed text-m-humo">{person.line}</p>
            <p className="m-num m-eyebrow mt-5 border-t border-m-linea pt-4 text-m-humo">
              <Pendiente value={person.meta} />
            </p>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}
