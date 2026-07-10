import { useEffect, useState, useCallback } from "react";
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
}

const ICONS: Record<ToastLevel, React.ReactNode> = {
  info: <Info size={16} className="text-blue-400" />,
  success: <CheckCircle size={16} className="text-octo-success" />,
  warning: <AlertTriangle size={16} className="text-octo-warning" />,
  error: <XCircle size={16} className="text-octo-danger" />,
};

let toastId = 0;

// Global toast API for imperative use.
type ToastFn = (t: Omit<Toast, "id">) => void;
let globalPush: ToastFn = () => {};
export function pushToast(t: Omit<Toast, "id">) {
  globalPush(t);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = String(++toastId);
    setToasts((prev) => [...prev, { ...t, id }]);
    const ms = t.timeout ?? 5000;
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, ms);
  }, []);

  // Expose globally.
  useEffect(() => {
    globalPush = push;
    return () => {
      globalPush = () => {};
    };
  }, [push]);

  const dismiss = (id: string) =>
    setToasts((prev) => prev.filter((x) => x.id !== id));

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
              <div className="mt-0.5 text-xs text-zinc-400">{t.body}</div>
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
