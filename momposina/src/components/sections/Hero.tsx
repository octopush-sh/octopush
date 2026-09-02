import { brand } from "../../content/brand";
import { whatsappUrl } from "../../content/contact";
import { hero, nav } from "../../content/content";
import { media } from "../../content/media";
import { Cta } from "../Cta";
import { Plate } from "../Plate";
import { Reveal } from "../Reveal";

/**
 * Hero.
 *
 * El nombre ocupa todo el ancho: es un nombre que quiere durar décadas, no
 * una etiqueta en una esquina. Debajo, una sola línea de texto — la página
 * abre con curiosidad, no con explicación.
 *
 * En móvil el orden es el que importa: nombre, frase, WhatsApp. La imagen
 * viene después, porque la mayoría llega desde Instagram y decide en los
 * primeros dos segundos.
 */
export function Hero() {
  return (
    <section
      id="hero"
      className="on-dark relative flex min-h-[100svh] flex-col justify-between bg-m-carbon text-m-crema"
    >
      <div className="mx-auto w-full max-w-[78rem] px-6 pt-28 md:px-10 md:pt-32">
        <Reveal>
          <p className="m-eyebrow text-m-oro">{hero.eyebrow}</p>
        </Reveal>

        <Reveal>
          <h1 className="m-wordmark mt-8 text-[clamp(2.4rem,10.4vw,9.3rem)] leading-[0.9] text-m-crema [margin-inline-end:-0.22em]">
            {brand.name}
          </h1>
        </Reveal>

        <Reveal>
          <p className="m-eyebrow mt-5 flex items-center gap-4 text-m-ceniza">
            <span className="inline-block h-px w-10 bg-m-oro" aria-hidden="true" />
            {brand.descriptor}
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 items-end gap-10 md:mt-16 md:grid-cols-12 md:gap-14">
          <div className="md:col-span-6">
            <Reveal>
              <p className="m-serif max-w-[20ch] text-[clamp(1.5rem,4.2vw,2.4rem)] text-m-crema">
                {hero.line}
              </p>
            </Reveal>

            <Reveal className="mt-10 flex flex-wrap items-center gap-4">
              <Cta href={whatsappUrl(hero.primaryCtaMessage)} surface="dark" external>
                {hero.primaryCta}
              </Cta>
              <Cta href="#piezas" surface="dark" variant="outline">
                {hero.secondaryCta}
              </Cta>
            </Reveal>
          </div>

          <Reveal className="md:col-span-5 md:col-start-8">
            <Plate slot={media.hero} priority sizes="(min-width: 768px) 40vw, 100vw" />
          </Reveal>
        </div>
      </div>

      {/* Señal de bajada: no dice "baje", dice qué viene. */}
      <a
        href={nav[0].href}
        className="mx-auto mt-16 flex w-full max-w-[78rem] items-center gap-4 px-6 pb-8 md:px-10"
      >
        <span className="m-eyebrow m-num text-m-oro">01</span>
        <span className="m-eyebrow text-m-ceniza">{nav[0].label}</span>
        <span className="h-px flex-1 bg-m-linea-oscura" aria-hidden="true" />
      </a>
    </section>
  );
}
