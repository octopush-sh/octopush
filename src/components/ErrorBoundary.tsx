import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { copyToClipboard } from "../lib/clipboard";
import { formatErrorDetails, reloadWindow, reportRenderError, toError } from "../lib/errorReport";

/**
 * Where a boundary sits, which decides what its fallback looks like:
 * - `root` replaces the whole window with a recovery screen (Reload Octopush);
 * - `panel` fills the crashed surface's own box with an inline card (Try again);
 * - `overlay` is for palettes and dialogs, which have no box of their own, so
 *   the card is presented in a ModalShell and can also be closed.
 */
export type ErrorBoundaryVariant = "root" | "panel" | "overlay";

interface Props {
  /** English name of the surface, used in the log line and the copied details
   *  (e.g. "Talk", "Command palette"). */
  surface: string;
  variant?: ErrorBoundaryVariant;
  /** `overlay` only: closes the surface (Close, Escape). The boundary resets
   *  as well, so the next time the surface opens, it mounts fresh. */
  onDismiss?: () => void;
  /** When this value changes, a caught error is cleared (e.g. the active
   *  workspace, so switching away from a broken workspace recovers). */
  resetKey?: unknown;
  /** `panel` only: render the fallback as a single icon button, for chrome
   *  too narrow for a card (the collapsed Companion). */
  compact?: boolean;
  /** `panel` only: the fallback takes the pointer itself, for a boundary
   *  inside a pointer-transparent layer (`TerminalHost`). */
  interactive?: boolean;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
}

/**
 * Catches errors thrown while rendering (or in effects) below it, so one
 * broken surface no longer unmounts the whole React root and blanks the window.
 *
 * This is the one class component in the app. React has no hook equivalent of
 * `getDerivedStateFromError` / `componentDidCatch`, so a boundary must be a class.
 * The fallbacks below are plain function components.
 *
 * "Try again" clears the error. Clearing it remounts the children from scratch,
 * because the fallback replaced them.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(thrown: unknown): Partial<State> {
    return { error: toError(thrown) };
  }

  componentDidCatch(thrown: unknown, info: ErrorInfo) {
    reportRenderError(this.props.surface, thrown, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && !Object.is(prev.resetKey, this.props.resetKey)) this.reset();
  }

  reset = () => this.setState({ error: null, componentStack: "" });

  dismiss = () => {
    this.props.onDismiss?.();
    this.reset();
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const { surface, variant = "panel", compact, interactive } = this.props;
    const details = () => formatErrorDetails(surface, error, componentStack);
    if (variant === "root") return <RootErrorScreen details={details} />;
    if (variant === "overlay") {
      return (
        <ModalShell onClose={this.dismiss} ariaLabel={`${surface} hit an error`} panelClassName="w-full max-w-[420px]">
          <div className="rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
            <PanelErrorBody surface={surface} details={details} onRetry={this.reset} onClose={this.dismiss} />
          </div>
        </ModalShell>
      );
    }
    if (compact) {
      return (
        <div className="flex h-full w-full justify-center pt-3 octo-fade-in">
          <button
            type="button"
            data-testid="panel-error-compact"
            onClick={this.reset}
            title={`${surface} hit an error · Try again`}
            aria-label={`${surface} hit an error. Try again`}
            className="rounded-md p-1.5 text-octo-rouge transition hover:bg-octo-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <AlertTriangle size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      );
    }
    return (
      <div
        className="flex h-full w-full min-w-0 flex-col items-center justify-center overflow-hidden px-8 py-6 text-center octo-fade-in"
        style={interactive ? { pointerEvents: "auto" } : undefined}
      >
        <PanelErrorBody surface={surface} details={details} onRetry={this.reset} />
      </div>
    );
  }
}

/** "Copy error details" with inline feedback. The root screen has no toasts. */
function CopyDetailsButton({ details }: { details: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={() => {
        void copyToClipboard(details()).then((ok) => setState(ok ? "copied" : "failed"));
      }}
      className="rounded-md px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy error details"}
    </button>
  );
}

function PanelErrorBody({
  surface,
  details,
  onRetry,
  onClose,
}: {
  surface: string;
  details: () => string;
  onRetry: () => void;
  onClose?: () => void;
}) {
  return (
    <div role="alert" data-testid="panel-error-card" className="flex flex-col items-center gap-3 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-rouge">{surface}</div>
      <div className="font-serif text-[18px] leading-tight tracking-[-0.005em] text-octo-ivory">
        This panel hit an error.
      </div>
      <p className="max-w-sm text-[12px] leading-[1.6] text-octo-sage">
        The rest of Octopush is still working. Try again to reload just this panel.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            Close
          </button>
        )}
        <CopyDetailsButton details={details} />
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-octo-border-strong px-4 py-2 font-serif text-[13px] text-octo-sage transition hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function RootErrorScreen({ details }: { details: () => string }) {
  return (
    <div
      role="alert"
      data-testid="root-error-screen"
      className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-octo-bg px-8 text-center text-octo-ivory octo-fade-in"
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-rouge">Something went wrong</div>
      <div className="font-serif text-[22px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Octopush hit an unexpected error.
      </div>
      <p className="max-w-md text-[13px] leading-[1.6] text-octo-sage">
        Your projects, workspaces and runs are kept on disk. Reload the window to carry on. If it keeps happening,
        copy the error details into a bug report.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <CopyDetailsButton details={details} />
        <button
          type="button"
          autoFocus
          onClick={reloadWindow}
          className="rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          Reload Octopush
        </button>
      </div>
    </div>
  );
}
