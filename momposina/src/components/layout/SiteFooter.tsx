import { brand } from "../../content/brand";
import { contact, whatsappUrl } from "../../content/contact";
import { footer, nav } from "../../content/content";
import { Mark } from "../Mark";
import { Pendiente } from "../Pendiente";

/** Pie. Cierra en carbón, como abrió la página. */
export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="on-dark bg-m-carbon text-m-ceniza">
      <div className="mx-auto w-full max-w-[78rem] px-6 py-16 md:px-10 md:py-20">
        <p className="m-serif max-w-[20ch] text-[clamp(1.4rem,4vw,2.2rem)] text-m-crema">
          {footer.line}
        </p>

        <div className="mt-14 grid grid-cols-1 gap-10 border-t border-m-linea-oscura pt-10 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <div className="flex items-center gap-3 text-m-crema">
              <Mark className="h-5 w-5 text-m-oro" />
              <span className="m-wordmark text-sm">{brand.name}</span>
            </div>
            <p className="m-eyebrow mt-4">{brand.descriptor}</p>
            <p className="m-eyebrow mt-2">{brand.place.short}</p>
          </div>

          <nav aria-label="Pie de página">
            <p className="m-eyebrow text-m-crema">Recorrido</p>
            <ul className="mt-4 space-y-2">
              {nav.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="m-link text-sm">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <p className="m-eyebrow text-m-crema">Escribir</p>
            <ul className="mt-4 space-y-2 text-sm">
              <li>
                <a
                  href={whatsappUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="m-link"
                >
                  WhatsApp
                </a>
              </li>
              <li>
                <a
                  href={contact.instagram.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="m-link"
                >
                  Instagram
                </a>
              </li>
              <li className="text-m-ceniza">
                <Pendiente value={contact.email.address} />
              </li>
            </ul>
          </div>

          <div>
            <p className="m-eyebrow text-m-crema">Taller</p>
            <p className="mt-4 text-sm">
              <Pendiente value={contact.address} />
            </p>
            <p className="m-eyebrow m-num mt-4">
              Desde <Pendiente value={brand.foundedYear} />
            </p>
          </div>
        </div>

        <div className="m-eyebrow mt-12 flex flex-col gap-2 border-t border-m-linea-oscura pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="m-num">
            © {year} {brand.name} · antes {brand.legalName}
          </p>
          <p>{brand.place.full}</p>
        </div>
      </div>
    </footer>
  );
}
