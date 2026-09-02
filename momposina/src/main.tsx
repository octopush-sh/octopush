import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Falta #root en el documento.");

const tree = (
  <StrictMode>
    <App />
  </StrictMode>
);

// `npm run build` deja el HTML ya renderizado dentro de #root (ver
// scripts/prerender.mjs): en ese caso se hidrata en vez de repintar, así el
// primer pintado no depende de JavaScript y el LCP no espera al bundle.
if (root.hasChildNodes()) {
  hydrateRoot(root, tree);
} else {
  createRoot(root).render(tree);
}
