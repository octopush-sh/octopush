// Settings › General › Attention — "Notify me elsewhere" (#964): an opt-in
// webhook for the moments a crew needs a decision while you're away. Off by
// default. The URL is saved (and validated by the backend: https, or http to
// this Mac only) when the field loses focus or on Enter; the switch turns on
// only with a URL; "Send a test" posts the test message to the URL in the
// field; the preview shows the exact body the backend builds.
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { NotifyElsewherePreview } from "../../lib/types";
import { Reveal } from "../primitives/Reveal";
import { Switch } from "./shared";

export const NOTIFY_LABEL = "Notify me elsewhere";
export const NOTIFY_HELP =
  "When a crew waits at a checkpoint gate or on a question, a crew run fails, or a Routine finishes, Octopush posts a short JSON message to the webhook you set here: ntfy, a Slack or Discord incoming webhook, or any URL. It carries a fixed label, the mission name and the project name, never code, diffs, prompts, questions or agent output. Off until you turn it on.";
export const NOTIFY_URL_PLACEHOLDER = "https://ntfy.sh/your-topic";

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

export function NotifyElsewhereRow() {
  const [enabled, setEnabled] = useState(false);
  const [savedUrl, setSavedUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [preview, setPreview] = useState<NotifyElsewherePreview | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    void (async () => {
      try {
        const s = await ipc.getNotifyElsewhere();
        if (!live.current) return;
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
    };
  }, []);

  /** Save the switch and the URL together; the backend answers with what it
   *  stored, so the row never shows a state that isn't saved. */
  async function persist(on: boolean, url: string) {
    setBusy(true);
    setError(null);
    try {
      const s = await ipc.setNotifyElsewhere(on, url);
      if (!live.current) return;
      setEnabled(s.enabled);
      setSavedUrl(s.url);
      setDraft(s.url);
      setSaved(true);
      setTimeout(() => {
        if (live.current) setSaved(false);
      }, 1500);
    } catch (e) {
      if (live.current) setError(notifyErrorText(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  function commitUrl() {
    const url = draft.trim();
    if (url === savedUrl) return;
    // Clearing the URL turns the setting off; a new URL keeps it as it was.
    void persist(enabled && url !== "", url);
  }

  function toggle(on: boolean) {
    // Off always goes through (with the saved URL); on uses the field.
    void persist(on, on ? draft.trim() : savedUrl);
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
          disabled={busy || (!enabled && !hasUrl)}
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

      {error && (
        <p data-testid="notify-elsewhere-error" className="octo-fade-in mt-2 font-mono text-[11px] text-octo-rouge">
          {error}
        </p>
      )}
      {!error && saved && (
        <p className="octo-fade-in mt-2 font-mono text-[10px] text-octo-verdigris">Saved</p>
      )}
      {test.kind === "sent" && (
        <p data-testid="notify-elsewhere-test-result" className="octo-fade-in mt-2 font-mono text-[11px] text-octo-verdigris">
          Test sent. The webhook accepted it.
        </p>
      )}
      {test.kind === "failed" && (
        <p data-testid="notify-elsewhere-test-result" className="octo-fade-in mt-2 font-mono text-[11px] text-octo-rouge">
          The test didn't send: {test.message}.
        </p>
      )}

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
            The exact message
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
                This is the body for a checkpoint gate, with example names. <code className="font-mono text-[11px] text-octo-ivory">event</code> is one of{" "}
                <span data-testid="notify-elsewhere-events" className="font-mono text-[11px] text-octo-ivory">
                  {preview.events.map((e) => e.event).join(", ")}
                </span>
                . Nothing else is sent.
              </p>
            </div>
          </Reveal>
        </div>
      )}
    </div>
  );
}
