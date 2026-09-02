import { brand } from "../../content/brand";
import { contact, whatsappUrl } from "../../content/contact";
import { contacto } from "../../content/content";
import { Cta } from "../Cta";
import { Eyebrow } from "../Eyebrow";
import { Pendiente } from "../Pendiente";
import { Reveal } from "../Reveal";

/**
 * Contacto.
 *
 * Hoy el embudo real es Instagram → WhatsApp, no un checkout. Los datos
 * salen de `content/contact.ts`: cambiar el número o el usuario no requiere
 * tocar un componente.
 */
export function Contacto() {
  return (
    <section
      id="contacto"
      aria-labelledby="contacto-titulo"
      className="on-dark bg-m-carbon-2 text-m-crema"
    >
      <div className="mx-auto grid w-full max-w-[78rem] grid-cols-1 gap-12 px-6 py-24 md:grid-cols-12 md:gap-14 md:px-10 md:py-36">
        <div className="md:col-span-7">
          <Reveal>
            <Eyebrow index={contacto.index} className="text-m-oro">
              {contacto.eyebrow}
            </Eyebrow>
          </Reveal>
          <Reveal>
            <h2 id="contacto-titulo" className="m-display mt-8 text-[clamp(2.6rem,10vw,5.5rem)]">
              {contacto.title}
            </h2>
          </Reveal>
          <Reveal as="p" className="mt-6 max-w-[40ch] text-lg leading-relaxed text-m-ceniza">
            {contacto.lead}
          </Reveal>

          <Reveal className="mt-10 flex flex-wrap items-center gap-4">
            <Cta href={whatsappUrl(contacto.primaryCtaMessage)} surface="dark" external>
              {contacto.primaryCta}
            </Cta>
            <Cta
              href={contact.instagram.url}
              surface="dark"
              variant="outline"
              external
            >
              {contacto.instagramCta}
            </Cta>
          </Reveal>

          <Reveal className="mt-8">
            <Cta href={whatsappUrl(contacto.designCtaMessage)} surface="dark" variant="quiet" external>
              {contacto.designCta}
            </Cta>
          </Reveal>
        </div>

        {/* Ficha de datos. Lo que no está confirmado se ve como pendiente. */}
        <Reveal className="md:col-span-4 md:col-start-9">
          <dl className="border-t border-m-linea-oscura">
            <div className="border-b border-m-linea-oscura py-5">
              <dt className="m-eyebrow text-m-ceniza">Dónde</dt>
              <dd className="mt-2 text-m-crema">{brand.place.full}</dd>
            </div>
            <div className="border-b border-m-linea-oscura py-5">
              <dt className="m-eyebrow text-m-ceniza">Atención</dt>
              <dd className="mt-2 text-m-crema">
                <Pendiente value={contact.hours} />
              </dd>
            </div>
            <div className="border-b border-m-linea-oscura py-5">
              <dt className="m-eyebrow text-m-ceniza">Instagram</dt>
              <dd className="mt-2 text-m-crema">
                <a
                  href={contact.instagram.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="m-link"
                >
                  <Pendiente value={contact.instagram.handle} />
                </a>
              </dd>
            </div>
            <div className="border-b border-m-linea-oscura py-5">
              <dt className="m-eyebrow text-m-ceniza">WhatsApp</dt>
              <dd className="m-num mt-2 text-m-crema">
                <Pendiente value={contact.whatsapp.display} />
              </dd>
            </div>
          </dl>
        </Reveal>
      </div>
    </section>
  );
}
