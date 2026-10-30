// The What's new dialog — one tip per page, shown after an update (and on
// demand from the palette / Settings › About). Tips come from the bundled
// changesets (lib/whatsNew.ts); "Show me" hands over to the guided tour.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, X } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { StageDots } from "./direct/StageDots";
import { useWhatsNewStore } from "../stores/whatsNewStore";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { ipc } from "../lib/ipc";
import { versionLabel, UNRELEASED } from "../lib/whatsNew";

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Markdown inline → nodes: **bold**, `code`, [text](https://…). Anything
 *  else stays literal text. */
export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: src.slice(last, at) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "code", text: m[2] });
    else out.push({ kind: "link", text: m[3], href: m[4] });
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ kind: "text", text: src.slice(last) });
  return out;
}

function InlineMarkdown({ text }: { text: string }) {
  const nodes: ReactNode[] = parseInline(text.replace(/\s*\n\s*/g, " ")).map((n, i) => {
    switch (n.kind) {
      case "bold":
        return <strong key={i} className="font-semibold text-octo-ivory">{n.text}</strong>;
      case "code":
        return <code key={i} className="rounded bg-octo-onyx px-1 font-mono text-[12px] text-octo-ivory">{n.text}</code>;
      case "link":
        return (
          <a
            key={i}
            href={n.href}
            onClick={(e) => {
              e.preventDefault();
              void ipc.openFileInSystem(n.href).catch(() => {});
            }}
            className="text-octo-brass underline decoration-[var(--brass-dim)] underline-offset-2 hover:decoration-octo-brass"
          >
            {n.text}
          </a>
        );
      default:
        return <Fragment key={i}>{n.text}</Fragment>;
    }
  });
  return <>{nodes}</>;
}

function Clip({ src, title }: { src: string; title: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(!reduced);

  // Reduced motion: never autoplay; the viewer starts it.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (reduced) {
      if (!v.paused) v.pause();
      setPlaying(false);
    }
  }, [reduced, src]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) {
      void v.play?.()?.catch?.(() => {});
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  return (
    <div className="relative mt-4 overflow-hidden rounded-lg border border-octo-hairline bg-octo-onyx">
      <video
        ref={ref}
        key={src}
        src={src}
        muted
        loop
        playsInline
        autoPlay={!reduced}
        aria-label={`Demo: ${title}`}
        className="block aspect-video w-full"
      />
      {reduced && (
        <button
          type="button"
          onClick={toggle}
          title={playing ? "Pause demo" : "Play demo"}
          aria-label={playing ? "Pause demo" : "Play demo"}
          className="absolute bottom-2 right-2 flex items-center justify-center rounded-md border border-octo-hairline bg-octo-panel p-1.5 text-octo-sage transition-colors hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          {playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
      )}
    </div>
  );
}

export function WhatsNewModal() {
  const phase = useWhatsNewStore((s) => s.phase);
  const tips = useWhatsNewStore((s) => s.tips);
  const index = useWhatsNewStore((s) => s.index);
  const { close, next, back, showMe } = useWhatsNewStore.getState();

  const open = phase === "modal" && tips.length > 0;

  // ←/→ page between tips (not while typing somewhere).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        useWhatsNewStore.getState().next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        useWhatsNewStore.getState().back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const tip = tips[Math.min(index, tips.length - 1)];
  const first = index === 0;
  const last = index === tips.length - 1;
  const hasTour = tip.steps.length > 0;
  const range = versionLabel(tips);
  const tipVersion = tip.version === UNRELEASED ? "Unreleased" : `v${tip.version}`;

  return (
    <ModalShell onClose={close} ariaLabel="What's new">
      <div className="w-[520px] max-w-[calc(100vw-48px)] rounded-xl border border-octo-hairline bg-octo-panel">
        <div className="flex items-center gap-3 px-6 pt-5">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">What's new</span>
          <span className="octo-tabular font-mono text-[10px] tracking-[0.1em] text-octo-mute" title={range !== tipVersion ? `This tip arrived in ${tipVersion}` : undefined}>
            {range}
          </span>
          <button
            type="button"
            onClick={close}
            title="Close"
            aria-label="Close"
            className="ml-auto flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <X size={12} />
          </button>
        </div>

        <div key={`${tip.version}/${tip.slug}`} className="octo-fade-in px-6 pb-2 pt-3">
          <h2 className="m-0 font-serif text-[22px] font-normal leading-[1.2] tracking-[-0.005em] text-octo-ivory">
            {tip.title}
          </h2>
          {range !== tipVersion && (
            <div className="mt-1 font-mono text-[10px] tracking-[0.1em] text-octo-mute">{tipVersion}</div>
          )}
          <p className="m-0 mt-2 text-[13px] leading-[1.6] text-octo-sage">
            <InlineMarkdown text={tip.body} />
          </p>
          {tip.clip && <Clip src={tip.clip} title={tip.title} />}
        </div>

        <div className="flex items-center gap-2 px-6 pb-5 pt-3">
          {tips.length > 1 && (
            <StageDots
              stages={tips.map((t, i) => ({
                status: i < index ? "done" : i === index ? "running" : "pending",
                title: t.title,
              }))}
            />
          )}
          <span className="ml-auto" />
          {!first && (
            <button
              type="button"
              onClick={back}
              title="Previous tip (←)"
              className="rounded-md border border-octo-hairline px-3 py-1.5 font-serif text-[13px] text-octo-sage transition-colors hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              Back
            </button>
          )}
          {hasTour && (
            <button
              type="button"
              onClick={() => void showMe()}
              title="Walk through it on the real app"
              className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1.5 font-serif text-[13px] text-octo-brass transition-colors hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              Show me
            </button>
          )}
          <button
            type="button"
            autoFocus
            onClick={last ? close : next}
            title={last ? "Close" : "Next tip (→)"}
            className="rounded-md border border-octo-hairline px-3 py-1.5 font-serif text-[13px] text-octo-ivory transition-colors hover:border-octo-border-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
