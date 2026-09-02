import { cn } from "../lib/cn";

type CtaProps = {
  href: string;
  children: React.ReactNode;
  /** Superficie sobre la que se apoya el botón. */
  surface?: "light" | "dark";
  variant?: "solid" | "outline" | "quiet";
  className?: string;
  /** Los enlaces externos (WhatsApp, Instagram) abren aparte. */
  external?: boolean;
};

const base =
  "inline-flex items-center justify-center transition-colors duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]";
const stamp = "m-eyebrow px-7 py-4";

const styles: Record<"light" | "dark", Record<"solid" | "outline" | "quiet", string>> = {
  light: {
    solid: `${stamp} bg-m-tinta text-m-papel hover:bg-m-oro-tierra`,
    outline: `${stamp} border border-m-tinta/30 text-m-tinta hover:border-m-tinta hover:bg-m-tinta hover:text-m-papel`,
    quiet: "m-link m-serif text-lg text-m-tinta hover:text-m-oro-tierra",
  },
  dark: {
    solid: `${stamp} bg-m-oro text-m-carbon hover:bg-m-oro-alto`,
    outline: `${stamp} border border-m-crema/25 text-m-crema hover:border-m-oro hover:text-m-oro`,
    quiet: "m-link m-serif text-lg text-m-crema hover:text-m-oro",
  },
};

/** Único componente de acción de la página. Sin bordes redondeados: el
 *  rectángulo es una decisión, igual que en una placa grabada. */
export function Cta({
  href,
  children,
  surface = "light",
  variant = "solid",
  className,
  external,
}: CtaProps) {
  return (
    <a
      href={href}
      className={cn(base, styles[surface][variant], className)}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}
