import { whatsappUrl } from "../../content/contact";
import { hechoParaTi } from "../../content/content";
import { media } from "../../content/media";
import { Cta } from "../Cta";
import { Eyebrow } from "../Eyebrow";
import { Plate } from "../Plate";
import { Reveal } from "../Reveal";
import { Section, Spread } from "../layout/Section";

/**
 * Hecho para ti.
 *
 * El servicio que casi ninguna joyería cuenta bien: traer lo que uno ya tiene
 * y convertirlo en otra cosa. Cinco pasos, sin prometer que todo material
 * sirve — eso se sabe después de evaluarlo, y la nota lo dice.
 */
export function HechoParaTi() {
  return (
    <Section
      id="hecho-para-ti"
      surface="papel"
      labelledBy="hecho-titulo"
      className="py-24 md:py-36"
    >
      <Spread>
        <div className="md:col-span-6">
          <Reveal>
            <Eyebrow index={hechoParaTi.index} className="text-m-oro-tierra">
              {hechoParaTi.eyebrow}
            </Eyebrow>
          </Reveal>
          <Reveal>
            <h2
              id="hecho-titulo"
              className="m-display mt-8 max-w-[14ch] text-[clamp(2.2rem,6.5vw,4.2rem)] text-balance"
            >
              {hechoParaTi.title}
            </h2>
          </Reveal>
          <div className="m-stagger mt-10 max-w-[46ch]">
            {hechoParaTi.paragraphs.map((paragraph, index) => (
              <Reveal
                as="p"
                key={paragraph}
                index={index}
                className="mt-5 text-lg leading-relaxed text-m-humo first:mt-0"
              >
                {paragraph}
              </Reveal>
            ))}
          </div>
        </div>

        <Reveal className="md:col-span-5 md:col-start-8">
          <Plate slot={media.hechoParaTi} sizes="(min-width: 768px) 40vw, 100vw" />
        </Reveal>
      </Spread>

      {/* El proceso, como una hoja de ruta del taller. */}
      <ol className="m-stagger mt-20 border-t border-m-linea md:mt-28">
        {hechoParaTi.steps.map((step, index) => (
          <Reveal
            as="li"
            key={step.n}
            index={index}
            className="grid grid-cols-1 gap-2 border-b border-m-linea py-7 md:grid-cols-12 md:gap-8"
          >
            <span className="m-num m-eyebrow text-m-oro-tierra md:col-span-1">{step.n}</span>
            <h3 className="m-display text-2xl md:col-span-4">{step.title}</h3>
            <p className="max-w-[52ch] leading-relaxed text-m-humo md:col-span-7">{step.line}</p>
          </Reveal>
        ))}
      </ol>

      <div className="mt-12 flex flex-col items-start gap-6 md:flex-row md:items-center md:justify-between">
        <p className="max-w-[54ch] text-sm leading-relaxed text-m-humo">{hechoParaTi.note}</p>
        <Cta href={whatsappUrl(hechoParaTi.ctaMessage)} external>
          {hechoParaTi.cta}
        </Cta>
      </div>
    </Section>
  );
}
