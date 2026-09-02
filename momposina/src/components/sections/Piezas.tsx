import { whatsappUrl } from "../../content/contact";
import { piezas } from "../../content/content";
import { products, type Product } from "../../content/products";
import { formatCOP } from "../../lib/format";
import { Cta } from "../Cta";
import { Eyebrow } from "../Eyebrow";
import { Pendiente } from "../Pendiente";
import { Plate } from "../Plate";
import { Reveal } from "../Reveal";
import { Section, Spread } from "../layout/Section";

/**
 * Piezas.
 *
 * Una selección, no un catálogo. La ficha se lee como una anotación de
 * taller — referencia, ley, peso — porque acá el peso es información, no un
 * detalle que se esconde.
 *
 * `products` puede venir mañana de un CMS o de una tienda sin tocar nada de
 * esto: la tarjeta solo depende de la forma de los datos.
 */
function Ficha({ product, index }: { product: Product; index: number }) {
  return (
    <Reveal as="li" index={index} className="group">
      <div className="overflow-hidden bg-m-crudo">
        <Plate
          slot={product.photo}
          sizes="(min-width: 1024px) 30vw, (min-width: 640px) 46vw, 100vw"
          className="transition-transform duration-[700ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      </div>

      <div className="mt-5 flex items-baseline justify-between gap-4 border-b border-m-linea pb-3">
        <h3 className="m-display text-xl">
          <Pendiente value={product.name} />
        </h3>
        <span className="m-num m-eyebrow text-m-oro-tierra">{product.ref}</span>
      </div>

      <p className="mt-3 text-m-humo">{product.type}</p>
      <p className="mt-2 max-w-[38ch] text-sm leading-relaxed text-m-humo">{product.line}</p>

      <dl className="m-num m-eyebrow mt-5 flex flex-wrap gap-x-6 gap-y-2 text-m-humo">
        <div className="flex gap-2">
          <dt className="opacity-60">Ley</dt>
          <dd>
            <Pendiente value={product.karat} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="opacity-60">Peso</dt>
          <dd>
            <Pendiente value={product.weight} />
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="opacity-60">Precio</dt>
          <dd>{product.price === null ? "A consultar" : formatCOP(product.price)}</dd>
        </div>
      </dl>
    </Reveal>
  );
}

export function Piezas() {
  return (
    <Section id="piezas" surface="crudo" labelledBy="piezas-titulo" className="py-24 md:py-36">
      <Spread className="items-end">
        <div className="md:col-span-6">
          <Reveal>
            <Eyebrow index={piezas.index} className="text-m-oro-tierra">
              {piezas.eyebrow}
            </Eyebrow>
          </Reveal>
          <Reveal>
            <h2 id="piezas-titulo" className="m-display mt-8 text-[clamp(2rem,5.5vw,3.4rem)]">
              {piezas.title}
            </h2>
          </Reveal>
        </div>
        <Reveal as="p" className="md:col-span-5 md:col-start-8 max-w-[42ch] text-lg leading-relaxed text-m-humo">
          {piezas.lead}
        </Reveal>
      </Spread>

      <ol className="m-stagger mt-16 grid grid-cols-1 gap-x-8 gap-y-14 sm:grid-cols-2 md:mt-24 lg:grid-cols-3">
        {products.map((product, index) => (
          <Ficha key={product.id} product={product} index={index % 3} />
        ))}
      </ol>

      <div className="mt-16 flex flex-col items-start gap-6 border-t border-m-linea pt-8 md:flex-row md:items-center md:justify-between">
        <p className="max-w-[46ch] text-sm leading-relaxed text-m-humo">{piezas.note}</p>
        <Cta href={whatsappUrl(piezas.ctaMessage)} variant="outline" external>
          {piezas.cta}
        </Cta>
      </div>
    </Section>
  );
}
