import { useState } from "react";
import { ModalShell } from "./ModalShell";

interface Props {
  /** Dialog heading, e.g. "New file" / "Rename". */
  title: string;
  /** Accessible label for the name input, e.g. "File name". */
  label: string;
  /** Pre-filled value (rename starts from the current name). */
  initial?: string;
  /** Confirm chip text, e.g. "Create" / "Rename". */
  confirmLabel: string;
  /** Called with the trimmed, validated name. The caller closes the dialog. */
  onSubmit: (name: string) => void;
  onClose: () => void;
  /** Override the default file-name validation (branch names allow slashes,
   *  stash messages allow anything). Return an error string or null. */
  validate?: (name: string) => string | null;
}

function validateName(name: string): string | null {
  if (name === "") return "Name is required.";
  if (name.includes("/") || name.includes("\\")) return "Name cannot contain slashes.";
  if (name === "." || name === "..") return `"${name}" is not a valid name.`;
  return null;
}

/**
 * Small prompt for capturing a single file or folder name — shared by the
 * tree's New file / New folder / Rename flows. Validation is inline (rouge,
 * rises in) and blocks submit; the backend re-validates regardless.
 */
export function FileNameDialog({
  title,
  label,
  initial = "",
  confirmLabel,
  onSubmit,
  onClose,
  validate = validateName,
}: Props) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const name = value.trim();
    const problem = validate(name);
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit(name);
  };

  return (
    <ModalShell onClose={onClose} ariaLabel={title} panelClassName="w-full max-w-[360px]">
      <div className="rounded-md border border-octo-hairline bg-octo-panel shadow-2xl">
        <div className="border-b border-octo-hairline px-4 py-3 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
          {title}
        </div>

        <div className="p-4">
          <input
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={label}
            autoFocus
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className="w-full rounded border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[13px] text-octo-ivory outline-none transition focus:border-octo-brass"
          />
          {error && (
            <p role="alert" className="octo-rise-in mt-2 font-mono text-[11px] text-octo-rouge">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition hover:text-octo-brass"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
