// Settings › General › Attention — "Notify me elsewhere" (#964): an opt-in
// webhook for the moments a crew needs a decision while you're away. Off by
// default. The URL is saved (and validated by the backend: https, or http to
// this Mac only) when the field loses focus or on Enter; the switch turns on
// only with a URL; "Send a test" posts the test message to the URL in the
// field; the preview shows the message's fields as the backend builds them.
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { NotifyElsewhere, NotifyElsewherePreview } from "../../lib/types";
import { FadeSwap } from "../primitives/FadeSwap";
import { Reveal } from "../primitives/Reveal";
import { Switch } from "./shared";

export const NOTIFY_LABEL = "Notify me elsewhere";
export const NOTIFY_HELP =
  "When a crew needs your decision (a checkpoint gate, a question, a Claude plan limit), a crew run fails, or a Routine finishes, Octopush posts a short JSON message to the webhook you set here: a Slack or Discord incoming webhook, or any endpoint that accepts JSON. It carries a fixed label, the project's name and the mission's title (the start of its task), never code, diffs, questions or agent output. Off until you turn it on; Send a test posts one test message either way.";
export const NOTIFY_URL_PLACEHOLDER = "https://hooks.example.com/…";

/** The backend's errors reach JS as `other: <message>` (`error.rs`). */
export function notifyErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  return raw.replace(/^other:\s*/, "");
}

type TestState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "failed"; message: string };

/** The one status line under the field. */
interface Status {
  key: string;
  ok: boolean;
  text: string;
  testId: string;
}

export function NotifyElsewhereRow() {
  const [enabled, setEnabled] = useState(false);
  const [savedUrl, setSavedUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [preview, setPreview] = useState<NotifyElsewherePreview | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const live = useRef(true);
  /** What the backend last stored: what a failed save falls back to. */
  const stored = useRef<NotifyElsewhere>({ enabled: false, url: "" });
  /** Saves run one after another, and only the newest one's answer is
   *  shown, so a URL saved on blur and the switch clicked right after land
   *  in that order and the switch doesn't flicker back. */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const seq = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStatus = useRef<Status | null>(null);

  useEffect(() => {
    live.current = true;
    void (async () => {
      try {
        const s = await ipc.getNotifyElsewhere();
        if (!live.current) return;
        stored.current = s;
        setEnabled(s.enabled);
        setSavedUrl(s.url);
        setDraft(s.url);
      } catch {
        // Stays off, which is the default.
      }
    })();
    void (async () => {
      try {
        const p = await ipc.notifyElsewherePreview();
        if (live.current) setPreview(p);
      } catch {
        // No preview to show; the setting still works.
      }
    })();
    return () => {
      live.current = false;
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  /** Save the switch and the URL together. `url` is read when the save
   *  runs, after the ones queued before it. The backend answers with what it
   *  stored, and the row shows that. */
  function persist(on: boolean, url: () => string) {
    const mine = ++seq.current;
    setError(null);
    queue.current = queue.current.then(async () => {
      try {
        const s = await ipc.setNotifyElsewhere(on, url());
        stored.current = s;
        if (!live.current || mine !== seq.current) return;
        setEnabled(s.enabled);
        setSavedUrl(s.url);
        setDraft(s.url);
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => {
          if (live.current) setSaved(false);
        }, 1500);
      } catch (e) {
        if (!live.current) return;
        setError(notifyErrorText(e));
        if (mine === seq.current) setEnabled(stored.current.enabled);
      }
    });
  }

  function commitUrl() {
    const url = draft.trim();
    if (url === savedUrl) return;
    // Clearing the URL turns the setting off; a new URL keeps it as it was.
    persist(enabled && url !== "", () => url);
  }

  function toggle(on: boolean) {
    // Show the click at once; the backend's answer then settles it. On uses
    // the field; off always goes through, with whatever URL is stored.
    setEnabled(on);
    const url = draft.trim();
    persist(on, on ? () => url : () => stored.current.url);
  }

  async function sendTest() {
    setTest({ kind: "sending" });
    try {
      await ipc.notifyElsewhereTest(draft.trim());
      if (live.current) setTest({ kind: "sent" });
    } catch (e) {
      if (live.current) setTest({ kind: "failed", message: notifyErrorText(e).replace(/\.$/, "") });
    }
  }

  const hasUrl = draft.trim() !== "";
  const switchTitle = !enabled && !hasUrl ? "Add a webhook URL first" : NOTIFY_LABEL;

  const status: Status | null = error
    ? { key: `error:${error}`, ok: false, text: error, testId: "notify-elsewhere-error" }
    : test.kind === "failed"
      ? {
          key: `test-failed:${test.message}`,
          ok: false,
          text: `The test didn't send: ${test.message}.`,
          testId: "notify-elsewhere-test-result",
        }
      : test.kind === "sent"
        ? { key: "test-sent", ok: true, text: "Test sent. The webhook accepted it.", testId: "notify-elsewhere-test-result" }
        : saved
          ? { key: "saved", ok: true, text: "Saved", testId: "notify-elsewhere-saved" }
          : null;
  // The line keeps its last words while it folds away, so it never blanks.
  if (status) lastStatus.current = status;
  const shown = status ?? lastStatus.current;

  return (
    <div
      data-tour="settings-notify-elsewhere"
      data-testid="notify-elsewhere-row"
      className="rounded-lg px-4 py-3"
      style={{ border: "1px solid var(--color-octo-hairline)", background: "var(--color-octo-panel)" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[14px] leading-tight text-octo-ivory">{NOTIFY_LABEL}</div>
          <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{NOTIFY_HELP}</div>
        </div>
        <Switch
          checked={enabled}
          onChange={toggle}
          ariaLabel={NOTIFY_LABEL}
          title={switchTitle}
          disabled={!enabled && !hasUrl}
          testId="notify-elsewhere-switch"
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          aria-label="Webhook URL"
          data-tour="settings-notify-elsewhere-url"
          data-testid="notify-elsewhere-url"
          value={draft}
          placeholder={NOTIFY_URL_PLACEHOLDER}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
            setTest({ kind: "idle" });
          }}
          onBlur={commitUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitUrl();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-1.5 font-mono text-[12px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute focus:border-octo-brass"
        />
        <button
          type="button"
          data-tour="settings-notify-elsewhere-test"
          data-testid="notify-elsewhere-test"
          disabled={!hasUrl || test.kind === "sending"}
          onClick={() => void sendTest()}
          title="Post the test message to this URL now, whether or not the setting is on"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-octo-border-strong px-3 py-1.5 font-serif text-[13px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory disabled:opacity-50 disabled:hover:text-octo-sage"
        >
          {test.kind === "sending" && <Loader2 size={12} className="animate-spin" aria-hidden />}
          {test.kind === "sending" ? "Sending…" : "Send a test"}
        </button>
      </div>

      <Reveal open={status !== null}>
        {shown && (
          <FadeSwap swapKey={shown.key}>
            <p
              data-testid={shown.testId}
              className={`pt-2 font-mono text-[11px] ${shown.ok ? "text-octo-verdigris" : "text-octo-rouge"}`}
            >
              {shown.text}
            </p>
          </FadeSwap>
        )}
      </Reveal>

      {preview && (
        <div className="mt-3">
          <button
            type="button"
            data-tour="settings-notify-elsewhere-payload"
            data-testid="notify-elsewhere-payload-toggle"
            aria-expanded={showPayload}
            onClick={() => setShowPayload((v) => !v)}
            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory"
          >
            <ChevronRight
              size={12}
              aria-hidden
              className={`transition-transform duration-[var(--dur-quick)] ease-[var(--ease-octo)] ${showPayload ? "rotate-90" : ""}`}
            />
            The message's fields
          </button>
          <Reveal open={showPayload}>
            <div className="pt-2">
              <pre
                data-testid="notify-elsewhere-payload"
                className="overflow-x-auto rounded-md bg-octo-onyx px-3 py-2 font-mono text-[11px] leading-[1.55] text-octo-ivory"
              >
                {JSON.stringify(preview.payload, null, 2)}
              </pre>
              <p className="mt-2 text-[12px] leading-[1.55] text-octo-sage">
                The fields of the message for a checkpoint gate, with example names. <code className="font-mono text-[11px] text-octo-ivory">event</code> is one of{" "}
                <span data-testid="notify-elsewhere-events" className="font-mono text-[11px] text-octo-ivory">
                  {preview.events.map((e) => e.event).join(", ")}
                </span>
                . No other field is sent.
              </p>
            </div>
          </Reveal>
        </div>
      )}
    </div>
  );
}
