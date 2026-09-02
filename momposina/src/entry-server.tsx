import { renderToString } from "react-dom/server";
import App from "./App";

export { head, documentTitle } from "./lib/seo";

/**
 * Render de build. La página es contenido estático: prerenderizarla le da
 * HTML completo a los buscadores y a quien comparte el enlace en WhatsApp,
 * sin montar un servidor ni cambiar de framework.
 */
export function render(): string {
  return renderToString(<App />);
}
