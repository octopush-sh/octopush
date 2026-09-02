import { createElement, type CSSProperties, type ReactNode } from "react";
import { useReveal } from "../hooks/useReveal";
import { cn } from "../lib/cn";

type RevealProps = {
  children: ReactNode;
  /** Etiqueta HTML a renderizar. Semántica primero: no todo es un div. */
  as?:
    | "div"
    | "p"
    | "li"
    | "figure"
    | "article"
    | "header"
    | "section"
    | "span"
    | "blockquote"
    | "h2"
    | "h3";
  className?: string;
  /** Posición dentro de un grupo escalonado (`.m-stagger`). */
  index?: number;
  style?: CSSProperties;
};

/** Envoltorio de revelado. Un solo gesto de entrada en toda la página. */
export function Reveal({ children, as = "div", className, index, style }: RevealProps) {
  const ref = useReveal<HTMLElement>();

  return createElement(
    as,
    {
      ref,
      className: cn("m-reveal", className),
      style: index === undefined ? style : ({ ...style, "--m-i": index } as CSSProperties),
    },
    children,
  );
}
