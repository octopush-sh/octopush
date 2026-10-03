import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { QuickViewApp } from "./quickview/QuickViewApp";
import { ipc } from "./lib/ipc";
import "./styles.css";

// Quick View windows (files opened from the OS) share this bundle but mount
// only the lightweight viewer — never the Atelier shell.
const isQuickView = ipc.currentWindowLabel().startsWith("quickview-");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isQuickView ? <QuickViewApp /> : <App />}</React.StrictMode>,
);
