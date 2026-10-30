// In-page caption / spotlight / cursor overlay for recordings made WITHOUT the
// app's own tour runner (the recorder's fallback driver). `installOverlay` is
// serialised into the page with `page.evaluate`, so it must be self-contained.
//
// Every colour, font and timing comes from the app's CSS custom properties
// (src/styles.css tokens) — nothing is hardcoded — so the overlay follows the
// scenario's theme like the real UI does.
export function installOverlay() {
  if (window.__octoClipOverlay) return;
  const EASE = "var(--ease-octo)";
  const DUR = "var(--dur-standard)";
  const layer = document.createElement("div");
  layer.setAttribute("data-octo-clip-overlay", "");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483646" });

  // Spotlight: a brass hairline ring whose huge spread shadow dims the rest.
  const ring = document.createElement("div");
  Object.assign(ring.style, {
    position: "fixed", left: "0", top: "0", width: "0", height: "0", borderRadius: "8px",
    boxShadow: "0 0 0 1px var(--color-octo-brass), 0 0 0 4px var(--brass-quiet), 0 0 0 9999px color-mix(in srgb, var(--color-octo-onyx) 45%, transparent)",
    opacity: "0",
    transition: `opacity ${DUR} ${EASE}, left ${DUR} ${EASE}, top ${DUR} ${EASE}, width ${DUR} ${EASE}, height ${DUR} ${EASE}`,
  });

  // Caption card: panel ground, hairline border, serif phrase.
  const card = document.createElement("div");
  Object.assign(card.style, {
    position: "fixed", left: "50%", maxWidth: "560px", transform: "translate(-50%, 8px)",
    padding: "14px 20px", borderRadius: "10px",
    background: "var(--color-octo-panel)", border: "1px solid var(--brass-dim)",
    color: "var(--color-octo-ivory)", fontFamily: "var(--font-serif)", fontSize: "17px", lineHeight: "1.45",
    boxShadow: "0 12px 40px color-mix(in srgb, var(--color-octo-onyx) 60%, transparent)",
    opacity: "0", transition: `opacity ${DUR} ${EASE}, transform ${DUR} ${EASE}, top ${DUR} ${EASE}`,
  });

  // Cursor: headless video shows no pointer, so draw a quiet one.
  const cursor = document.createElement("div");
  Object.assign(cursor.style, {
    position: "fixed", left: "640px", top: "760px", width: "14px", height: "14px", marginLeft: "-7px", marginTop: "-7px",
    borderRadius: "50%", background: "color-mix(in srgb, var(--color-octo-ivory) 85%, transparent)",
    border: "1px solid var(--color-octo-onyx)", opacity: "0",
    transition: `left var(--dur-slow) ${EASE}, top var(--dur-slow) ${EASE}, opacity ${DUR} ${EASE}, transform var(--dur-quick) ${EASE}`,
  });

  layer.append(ring, card, cursor);
  document.body.appendChild(layer);

  window.__octoClipOverlay = {
    spotlight(rect) {
      if (!rect) { ring.style.opacity = "0"; return; }
      const pad = 6;
      Object.assign(ring.style, {
        left: `${rect.x - pad}px`, top: `${rect.y - pad}px`,
        width: `${rect.width + pad * 2}px`, height: `${rect.height + pad * 2}px`, opacity: "1",
      });
    },
    caption(text, rect) {
      if (!text) { card.style.opacity = "0"; card.style.transform = "translate(-50%, 8px)"; return; }
      card.textContent = text;
      // Keep the card clear of the target: bottom unless the target lives there.
      const low = rect && rect.y + rect.height / 2 > window.innerHeight * 0.6;
      card.style.top = low ? "48px" : `${window.innerHeight - 120}px`;
      card.style.opacity = "1";
      card.style.transform = "translate(-50%, 0)";
    },
    cursorTo(x, y) {
      cursor.style.opacity = "1";
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    },
    press() {
      cursor.style.transform = "scale(0.7)";
      setTimeout(() => { cursor.style.transform = "scale(1)"; }, 180);
    },
    clear() {
      ring.style.opacity = "0";
      card.style.opacity = "0";
      cursor.style.opacity = "0";
    },
  };
}
