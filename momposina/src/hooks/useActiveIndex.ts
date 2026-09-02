import { useEffect, useState, type RefObject } from "react";

/**
 * Devuelve el índice del elemento que domina la pantalla, para la palabra
 * fija de la sección Transformación.
 *
 * Es un IntersectionObserver con umbrales, no un listener de scroll: el
 * navegador hace el cálculo y no se recompone en cada frame. Sin scroll
 * hijacking — el usuario sigue mandando en su propio scroll.
 */
export function useActiveIndex(refs: Array<RefObject<HTMLElement | null>>) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const nodes = refs.map((r) => r.current).filter((n): n is HTMLElement => n !== null);
    if (nodes.length === 0 || typeof IntersectionObserver === "undefined") return;

    const visibility = new Map<Element, number>();

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visibility.set(entry.target, entry.intersectionRatio);

        let best = -1;
        let bestRatio = 0;
        nodes.forEach((node, index) => {
          const ratio = visibility.get(node) ?? 0;
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = index;
          }
        });
        if (best >= 0) setActive(best);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: "-25% 0px -25% 0px" },
    );

    nodes.forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, [refs]);

  return active;
}
