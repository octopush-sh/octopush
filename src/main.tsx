import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { ipc } from "./lib/ipc";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// Quick View windows (files opened from the OS) share this bundle but load
// only the lightweight viewer. Loading lazily matters: importing App would
// pull in every store, and some register app-wide event listeners at module
// load (run logs, checkpoints) that would then run once per Quick View.
const isQuickView = ipc.currentWindowLabel().startsWith("quickview-");
const Root = isQuickView
  ? lazy(() => import("./quickview/QuickViewApp").then((m) => ({ default: m.QuickViewApp })))
  : lazy(() => import("./App"));

// The root boundary is the last line of defence: a render error that no
// surface boundary caught shows a recovery screen instead of a blank window.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary surface={isQuickView ? "Quick View" : "Octopush"} variant="root">
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
