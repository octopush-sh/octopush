import { useEffect, useRef, useState } from "react";
import { OctoRig } from "../icons/OctoMark";
import { useReducedMotion } from "../../hooks/useReducedMotion";

/** Max eye travel in canonical units; cursor influence saturates at 240px. */
const MAX_OFFSET = 2.4;
const SATURATION_PX = 240;
const IDLE_MS = 15_000;
const LERP = 0.14;

/** Pure gaze math: eye offset toward (mx,my) from the eye center (cx,cy). */
export function gazeOffset(cx: number, cy: number, mx: number, my: number) {
  const dx = mx - cx,
    dy = my - cy;
  const d = Math.hypot(dx, dy) || 1;
  const m = Math.min(1, d / SATURATION_PX) * MAX_OFFSET;
  return { x: (dx / d) * m, y: (dy / d) * m };
}

type Gesture = "none" | "look" | "scratch" | "peek";

/** The Watcher — the Talk empty-state Octo (spec 2026-07-19 §3):
 *  eyes follow the cursor across the chat canvas with calm inertia;
 *  after 15s of keyboard silence it fidgets (look → scratch → peek). */
export function OctoWatcher({
  size = 72,
  areaRef,
}: {
  size?: number;
  areaRef: React.RefObject<HTMLElement | null>;
}) {
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const eyesEl = useRef<SVGGElement | null>(null);
  const cur = useRef({ x: 0, y: 0 });
  const target = useRef({ x: 0, y: 0 });
  const gestureRef = useRef<Gesture>("none");
  const [gesture, setGesture] = useState<Gesture>("none");
  const cycle = useRef(0);

  // Gaze: mousemove on the canvas + rAF lerp loop.
  // Spec §3: under prefers-reduced-motion there is NO gaze-follow and NO
  // fidgeting — the CSS neutralizer can't stop a JS engine, so guard here.
  // `reduced` is live (matchMedia listener): flipping the OS setting stops
  // the engine mid-flight and re-centers the eyes.
  useEffect(() => {
    if (reduced) return;
    eyesEl.current = svgRef.current?.querySelector(".octo-m-eyes") ?? null;
    const area = areaRef.current;
    if (!area) return;
    const onMove = (e: MouseEvent) => {
      if (gestureRef.current !== "none") return;
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return;
      target.current = gazeOffset(
        r.left + r.width / 2,
        r.top + r.height * 0.42,
        e.clientX,
        e.clientY,
      );
    };
    area.addEventListener("mousemove", onMove);
    let raf = 0;
    const loop = () => {
      cur.current.x += (target.current.x - cur.current.x) * LERP;
      cur.current.y += (target.current.y - cur.current.y) * LERP;
      eyesEl.current?.setAttribute(
        "transform",
        `translate(${cur.current.x.toFixed(2)} ${cur.current.y.toFixed(2)})`,
      );
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      area.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(raf);
      cur.current = { x: 0, y: 0 };
      target.current = { x: 0, y: 0 };
      eyesEl.current?.removeAttribute("transform");
    };
  }, [areaRef, reduced]);

  // Fidget scheduler: 15s of keyboard silence → next gesture in the cycle.
  useEffect(() => {
    if (reduced) return;
    let idleTimer: ReturnType<typeof setTimeout>;
    const stepTimers: Array<ReturnType<typeof setTimeout>> = [];
    const setG = (g: Gesture) => {
      gestureRef.current = g;
      setGesture(g);
    };

    const runGesture = () => {
      const which = (["look", "scratch", "peek"] as const)[cycle.current % 3];
      cycle.current += 1;
      setG(which);
      const done = (after: number) =>
        stepTimers.push(
          setTimeout(() => {
            setG("none");
            target.current = { x: 0, y: 0 };
            arm();
          }, after),
        );
      if (which === "look") {
        target.current = { x: -2.4, y: 0 };
        stepTimers.push(setTimeout(() => { target.current = { x: 2.4, y: 0 }; }, 700));
        stepTimers.push(setTimeout(() => { target.current = { x: 0, y: -0.5 }; }, 1400));
        done(1800);
      } else if (which === "scratch") {
        target.current = { x: 1.8, y: -1.2 };
        done(2800);
      } else {
        target.current = { x: 0, y: 2.6 };
        done(1100);
      }
    };

    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(runGesture, IDLE_MS);
    };
    const onKey = () => {
      if (gestureRef.current === "none") arm();
    };
    window.addEventListener("keydown", onKey);
    arm();
    return () => {
      clearTimeout(idleTimer);
      stepTimers.forEach(clearTimeout);
      window.removeEventListener("keydown", onKey);
      setG("none");
    };
  }, [reduced]);

  return (
    <svg
      ref={svgRef}
      width={size}
      height={Math.round((size * 66) / 64)}
      viewBox="0 0 64 66"
      aria-hidden="true"
      focusable="false"
      data-gesture={gesture}
      className={`octo-mascot octo-mascot--idle${gesture === "scratch" ? " octo-g-scratch" : ""}`}
    >
      <OctoRig eyeR={3} showBack />
    </svg>
  );
}
