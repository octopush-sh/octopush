import { useEffect, useState } from "react";
import { brand } from "../../content/brand";
import { whatsappUrl } from "../../content/contact";
import { nav } from "../../content/content";
import { cn } from "../../lib/cn";
import { Mark } from "../Mark";

/**
 * Encabezado discreto.
 *
 * Sobre el hero es casi invisible — la marca no se presenta dos veces en la
 * misma pantalla. Al salir del hero se apoya en hueso y aparece el filete.
 * El estado se decide con un IntersectionObserver sobre el hero, no con un
 * listener de scroll: cero trabajo por frame.
 */
export function SiteHeader() {
  const [landed, setLanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const hero = document.getElementById("hero");
    if (!hero || typeof IntersectionObserver === "undefined") {
      setLanded(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setLanded(!entry.isIntersecting), {
      rootMargin: "-72px 0px 0px 0px",
    });
    io.observe(hero);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  return (
    <>
      <header
        className={cn(
          "fixed inset-x-0 top-0 z-50 transition-colors duration-[320ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]",
          landed
            ? "border-b border-m-linea bg-m-crudo/95 text-m-tinta backdrop-blur-sm"
            : "on-dark border-b border-transparent text-m-crema",
        )}
      >
        <div className="mx-auto flex h-[4.5rem] w-full max-w-[78rem] items-center justify-between px-6 md:px-10">
          <a
            href="#hero"
            className="flex items-center gap-3"
            aria-label={`${brand.name}, inicio`}
          >
            <Mark className={cn("h-5 w-5", landed ? "text-m-oro-tierra" : "text-m-oro")} />
            {/* Sobre el hero el nombre ya está escrito a pantalla completa:
                repetirlo en la barra sería decirlo dos veces. Queda la pepita. */}
            <span
              className={cn(
                "m-wordmark hidden text-sm transition-opacity duration-[320ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] sm:inline",
                landed ? "opacity-100" : "opacity-0",
              )}
            >
              {brand.name}
            </span>
          </a>

          <nav aria-label="Principal" className="hidden items-center gap-8 lg:flex">
            {nav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="m-eyebrow transition-opacity duration-[220ms] hover:opacity-60"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <a
              href={whatsappUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "m-eyebrow inline-flex px-4 py-3 transition-colors duration-[220ms] sm:px-5",
                landed
                  ? "bg-m-tinta text-m-papel hover:bg-m-oro-tierra"
                  : "border border-m-crema/30 text-m-crema hover:border-m-oro hover:text-m-oro",
              )}
            >
              WhatsApp
            </a>
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-expanded={menuOpen}
              aria-controls="menu-movil"
              className="m-eyebrow px-3 py-3 lg:hidden"
            >
              Menú
            </button>
          </div>
        </div>
      </header>

      {menuOpen && (
        <div
          id="menu-movil"
          role="dialog"
          aria-modal="true"
          aria-label="Navegación"
          className="on-dark fixed inset-0 z-[60] flex flex-col bg-m-carbon text-m-crema"
          style={{ animation: "m-sheet var(--m-dur) var(--m-ease)" }}
        >
          <div className="flex h-[4.5rem] items-center justify-between px-6">
            <span className="m-wordmark text-sm">{brand.name}</span>
            <button type="button" onClick={() => setMenuOpen(false)} className="m-eyebrow px-3 py-3">
              Cerrar
            </button>
          </div>
          <nav aria-label="Principal, móvil" className="flex flex-1 flex-col justify-center gap-2 px-6">
            {nav.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="m-display border-b border-m-linea-oscura py-4 text-3xl"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="px-6 pb-10">
            <p className="m-eyebrow text-m-ceniza">{brand.place.full}</p>
            <a
              href={whatsappUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="m-eyebrow mt-4 inline-flex bg-m-oro px-7 py-4 text-m-carbon"
            >
              Escribir por WhatsApp
            </a>
          </div>
        </div>
      )}
    </>
  );
}
