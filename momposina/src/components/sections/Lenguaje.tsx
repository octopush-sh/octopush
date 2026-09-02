import { lenguaje } from "../../content/content";
import { media } from "../../content/media";
import { Eyebrow } from "../Eyebrow";
import { Plate } from "../Plate";
import { Reveal } from "../Reveal";
import { Section, Spread } from "../layout/Section";

/**
 * Nuestro lenguaje.
 *
 * La sección que decide si esta marca tiene identidad o no. La estética
 * joyera de la región no se presenta como una versión menor de la joyería
 * internacional: se presenta como el punto de partida. Por eso el contraste
 * tipográfico — la frase que susurra en gris, la respuesta a tamaño completo.
 */
export function Lenguaje() {
  return (
    <Section id="lenguaje" surface="crudo" labelledBy="lenguaje-titulo" className="py-24 md:py-36">
      <Reveal>
        <Eyebrow index={lenguaje.index} className="text-m-oro-tierra">
          {lenguaje.eyebrow}
        </Eyebrow>
      </Reveal>

      <div className="m-stagger mt-10 md:mt-14">
        <Reveal
          as="p"
          index={0}
          className="m-display text-[clamp(1.8rem,6vw,4rem)] text-m-piedra"
        >
          {lenguaje.titleQuiet}
        </Reveal>
        <Reveal
          as="h2"
          index={1}
          className="m-display text-[clamp(2.8rem,12vw,8.5rem)] text-m-tinta"
        >
          <span id="lenguaje-titulo">{lenguaje.titleLoud}</span>
        </Reveal>
      </div>

      <Spread className="mt-16 md:mt-24">
        <Reveal className="md:col-span-5">
          <Plate slot={media.lenguajeMacro} sizes="(min-width: 768px) 38vw, 100vw" />
        </Reveal>

        <div className="md:col-span-6 md:col-start-7">
          <div className="m-stagger max-w-[52ch]">
            {lenguaje.paragraphs.map((paragraph, index) => (
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

          {/* Los rasgos, en forma de libro de taller: etiqueta y anotación. */}
          <dl className="m-stagger mt-12 border-t border-m-linea">
            {lenguaje.traits.map((trait, index) => (
              <Reveal
                key={trait.label}
                index={index}
                className="grid grid-cols-1 gap-1 border-b border-m-linea py-5 sm:grid-cols-[10rem_1fr] sm:gap-6"
              >
                <dt className="m-eyebrow text-m-oro-tierra">{trait.label}</dt>
                <dd className="max-w-[46ch] leading-relaxed text-m-humo">{trait.line}</dd>
              </Reveal>
            ))}
          </dl>
        </div>
      </Spread>

      <Reveal className="mt-16 md:mt-24">
        <Plate slot={media.lenguajeCuerpo} sizes="100vw" className="max-h-[80vh]" />
      </Reveal>
    </Section>
  );
}
