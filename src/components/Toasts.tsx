import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, CheckCircle, XCircle, Info, X } from "lucide-react";
import { clsx } from "clsx";

export type ToastLevel = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  level: ToastLevel;
  title: string;
  body?: string;
  timeout?: number;
  /** Optional primary action (e.g. "Rename"). Clicking it runs `onClick` and
   *  dismisses the toast. */
  action?: { label: string; onClick: () => void };
}

const ICONS: Record<ToastLevel, React.ReactNode> = {
  info: <Info size={16} className="text-blue-400" />,
  success: <CheckCircle size={16} className="text-octo-success" />,
  warning: <AlertTriangle size={16} className="text-octo-warning" />,
  error: <XCircle size={16} className="text-octo-danger" />,
};

let toastId = 0;

// The live toasts are module state, not a container's own: the app mounts a
// different `ToastContainer` per top-level view (Welcome, New project, the
// shell), so a toast pushed while one is on screen — or before any is —
// must still be there when the next one mounts (#642).
let liveToasts: Toast[] = [];
const subscribers = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function setLiveToasts(next: Toast[]) {
  liveToasts = next;
  subscribers.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

function removeToast(id: string) {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  if (liveToasts.some((x) => x.id === id)) setLiveToasts(liveToasts.filter((x) => x.id !== id));
}

/** Show a toast in whichever `ToastContainer` is mounted, now or next. It
 *  leaves after `timeout` ms (default 5000), counted from this call. */
export function pushToast(t: Omit<Toast, "id">) {
  const id = String(++toastId);
  setLiveToasts([...liveToasts, { ...t, id }]);
  timers.set(
    id,
    setTimeout(() => removeToast(id), t.timeout ?? 5000),
  );
}

/** Test-only: drop every toast and its timer. */
export function resetToastsForTest() {
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
  setLiveToasts([]);
}

export function ToastContainer() {
  const toasts = useSyncExternalStore(subscribe, () => liveToasts);
  const push = pushToast;
  const dismiss = removeToast;

  // Listen for backend-emitted notification events.
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    listen<{ sessionId: string; message: string }>("octopush://budget-warning", (ev) => {
      push({
        level: "warning",
        title: "Budget warning",
        body: ev.payload.message,
      });
    }).then((u) => unsubs.push(u));

    listen<{ sessionId: string; error: string }>("octopush://session-error", (ev) => {
      push({
        level: "error",
        title: "Session error",
        body: ev.payload.error,
      });
    }).then((u) => unsubs.push(u));

    listen<{ sessionId: string }>("pty://exit", (ev) => {
      push({
        level: "info",
        title: "Session exited",
        body: `Session ${ev.payload.sessionId.slice(0, 8)}… has ended.`,
      });
    }).then((u) => unsubs.push(u));

    return () => unsubs.forEach((u) => u());
  }, [push]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "pointer-events-auto flex w-80 items-start gap-3 rounded-lg border bg-octo-panel p-3 shadow-xl animate-in slide-in-from-right",
            t.level === "error"
              ? "border-octo-danger/40"
              : t.level === "warning"
                ? "border-octo-warning/40"
                : "border-octo-border",
          )}
        >
          <span className="mt-0.5 shrink-0">{ICONS[t.level]}</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t.title}</div>
            {t.body && (
              <div className="mt-0.5 break-words text-xs text-zinc-400">{t.body}</div>
            )}
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="mt-2 rounded-md px-2.5 py-1 font-serif text-[12px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
