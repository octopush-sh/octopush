// The system Safari as a visual-audit engine, through safaridriver (WebDriver).
//
// Playwright's WebKit is its own, newer build. Octopush runs in the system
// WKWebView, the WebKit that ships with macOS, so a layout bug can show in the
// app and not in Playwright (#312: names that truncate in Playwright WebKit
// spilled out of their cards on the owner's macOS 15.7). Safari uses that same
// system WebKit, so it gets as close to the app as a browser can.
//
// Exposes the tiny slice of Playwright's API that audit.mjs uses. Safari allows
// one automation session at a time, so every "page" shares one window.
// macOS only; once per machine: `sudo safaridriver --enable`.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

/** Wrap a function for WebDriver's execute: called with the given arguments, its result returned. */
export const scriptFor = (fn) => `return (${fn.toString()}).apply(null, arguments);`;

export async function launchSafari() {
  const port = await freePort();
  const proc = spawn("safaridriver", ["-p", String(port)], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`safaridriver ${method} ${path}: ${j.value?.message ?? r.status}`);
    return j.value;
  };
  let session;
  for (let i = 0; i < 40 && !session; i++) {
    try { session = (await call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } })).sessionId; }
    catch (e) { if (i === 39) { proc.kill(); throw new Error(`can't start Safari automation (run \`sudo safaridriver --enable\` once): ${e.message}`); } await sleep(250); }
  }
  const s = (path) => `/session/${session}${path}`;
  const evaluate = (fn, arg) => call("POST", s("/execute/sync"), { script: scriptFor(fn), args: arg === undefined ? [] : [arg] });

  const page = {
    clock: { setFixedTime: async () => {} }, // no clock control over WebDriver; relative times may differ
    on: () => {},                             // page errors are collected through window.onerror below
    async goto(url) {
      await call("POST", s("/url"), { url });
      await evaluate(() => {
        window.__auditErrors = [];
        window.addEventListener("error", (e) => window.__auditErrors.push(String(e.message)));
        window.addEventListener("unhandledrejection", (e) => window.__auditErrors.push(String(e.reason?.message ?? e.reason)));
      });
    },
    async waitForFunction(fn, _arg, { timeout = 30_000 } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await evaluate(fn)) return; await sleep(250); }
      throw new Error("timed out waiting for the harness");
    },
    evaluate,
    waitForLoadState: async () => {},
    waitForTimeout: sleep,
    async setViewportSize({ width, height }) {
      // The window rect includes Safari's chrome: size it, measure the viewport, correct.
      await call("POST", s("/window/rect"), { width, height });
      const v = await evaluate(() => [window.innerWidth, window.innerHeight]);
      await call("POST", s("/window/rect"), { width: width + (width - v[0]), height: height + (height - v[1]) });
    },
    async screenshot({ path }) { writeFileSync(path, Buffer.from(await call("GET", s("/screenshot")), "base64")); },
    errors: () => evaluate(() => window.__auditErrors ?? []),
    close: async () => { await call("POST", s("/url"), { url: "about:blank" }).catch(() => {}); },
  };
  return {
    newContext: async () => ({ newPage: async () => page }),
    async close() { await call("DELETE", s("")).catch(() => {}); proc.kill(); },
  };
}
