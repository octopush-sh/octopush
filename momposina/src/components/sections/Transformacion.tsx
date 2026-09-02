import { createRef, useMemo } from "react";
import { transformacion } from "../../content/content";
import { media, type MediaKey } from "../../content/media";
import { useActiveIndex } from "../../hooks/useActiveIndex";
import { cn } from "../../lib/cn";
import { Eyebrow } from "../Eyebrow";
import { Plate } from "../Plate";
import { Reveal } from "../Reveal";
import { Rule } from "../Rule";

/**
 * Transformación — el momento central de la página.
 *
 * Cinco estados del mismo metal. En escritorio la palabra se queda fija a la
 * izquierda y cambia mientras el material pasa por la derecha; en móvil la
 * secuencia simplemente se recorre. No hay scroll secuestrado, no hay
 * animación atada al scroll: el navegador decide cuándo cambia la palabra y
 * el usuario sigue mandando en su propio scroll.
 */
export function Transformacion() {
  const refs = useMemo(
    () => transformacion.beats.map(() => createRef<HTMLLIElement>()),
    [],
  );
  const active = useActiveIndex(refs);

  return (
    <section
      id="transformacion"
      aria-labelledby="transformacion-titulo"
      className="on-dark bg-m-carbon text-m-crema"
    >
      <div className="mx-auto w-full max-w-[78rem] px-6 pt-24 md:px-10 md:pt-36">
        <Reveal>
          <Eyebrow index={transformacion.index} className="text-m-oro">
            {transformacion.eyebrow}
          </Eyebrow>
        </Reveal>
        <Reveal>
          <h2
            id="transformacion-titulo"
            className="m-display mt-8 max-w-[16ch] text-[clamp(2rem,6vw,3.8rem)]"
          >
            {transformacion.title}
          </h2>
        </Reveal>
      </div>

      <div className="mx-auto grid w-full max-w-[78rem] grid-cols-1 gap-12 px-6 py-20 md:grid-cols-12 md:gap-14 md:px-10 md:py-28">
        {/* Columna fija: la palabra del estado en curso. Solo en escritorio,
            donde hay alto de sobra para que valga la pena. */}
        <div className="hidden md:col-span-5 md:block">
          <div className="sticky top-[28vh]">
            <ol className="flex flex-col gap-3" aria-hidden="true">
              {transformacion.beats.map((beat, index) => (
                <li
                  key={beat.n}
                  className={cn(
                    "m-num m-eyebrow transition-colors duration-[320ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]",
                    index === active ? "text-m-oro" : "text-m-ceniza/45",
                  )}
                >
                  {beat.n}
                </li>
              ))}
            </ol>

            <div className="relative mt-10 h-[9rem]">
              {transformacion.beats.map((beat, index) => (
                <p
                  key={beat.word}
                  aria-hidden={index !== active}
                  className={cn(
                    "m-display absolute inset-x-0 top-0 text-[clamp(3rem,7vw,5.5rem)] uppercase transition-all duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]",
                    index === active
                      ? "translate-y-0 opacity-100"
                      : "pointer-events-none translate-y-2 opacity-0",
                  )}
                >
                  {beat.word}
                </p>
              ))}
            </div>

            <div className="relative mt-4 h-24 max-w-[34ch]">
              {transformacion.beats.map((beat, index) => (
                <p
                  key={beat.n}
                  aria-hidden={index !== active}
                  className={cn(
                    "absolute inset-x-0 top-0 text-lg leading-relaxed text-m-ceniza transition-opacity duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]",
                    index === active ? "opacity-100" : "opacity-0",
                  )}
                >
                  {beat.line}
                </p>
              ))}
            </div>
          </div>
        </div>

        {/* Columna que corre. En móvil es la secuencia completa, con su
            propia tipografía: nadie se pierde por no tener columna fija. */}
        <ol className="md:col-span-6 md:col-start-7">
          {transformacion.beats.map((beat, index) => (
            <li
              key={beat.n}
              ref={refs[index]}
              className="mb-16 last:mb-0 md:mb-28"
            >
              <div className="mb-5 flex items-baseline gap-4 md:hidden">
                <span className="m-num m-eyebrow text-m-oro">{beat.n}</span>
                <h3 className="m-display text-[clamp(2.2rem,10vw,3.4rem)] uppercase">
                  {beat.word}
                </h3>
              </div>
              <Reveal>
                <Plate
                  slot={media[beat.media as MediaKey]}
                  sizes="(min-width: 768px) 46vw, 100vw"
                />
              </Reveal>
              <p className="mt-5 max-w-[38ch] text-base leading-relaxed text-m-ceniza md:hidden">
                {beat.line}
              </p>
            </li>
          ))}
        </ol>
      </div>

      {/* El remate a dos tiempos. Es la frase que resume la marca entera. */}
      <div className="mx-auto w-full max-w-[78rem] border-t border-m-linea-oscura px-6 py-24 md:px-10 md:py-36">
        <div className="m-stagger">
          <Reveal as="p" index={0} className="m-display text-[clamp(2rem,7vw,4.6rem)] text-m-ceniza">
            {transformacion.close.before}
          </Reveal>
          <Rule className="my-8 max-w-[18rem] text-m-oro" />
          <Reveal as="p" index={2} className="m-display text-[clamp(2rem,7vw,4.6rem)] text-m-crema">
            {transformacion.close.after}
          </Reveal>
        </div>
      </div>
    </section>
  );
}
