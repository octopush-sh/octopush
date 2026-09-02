import { useEffect, useRef } from "react";

/**
 * Revelado al entrar en pantalla.
 *
 * Añade `is-in` una sola vez y deja de observar: no hay trabajo por scroll,
 * no hay listener de scroll, y el elemento no vuelve a esconderse cuando el
 * usuario sube (que es lo que hace que una página se sienta nerviosa).
 *
 * Si no hay IntersectionObserver — o el HTML se sirve sin JS — el contenido
 * queda visible. Nunca se oculta información detrás de una animación.
 */
export function useReveal<T extends HTMLElement>(threshold = 0.12) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("is-in");
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      },
      { threshold, rootMargin: "0px 0px -6% 0px" },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return ref;
}
