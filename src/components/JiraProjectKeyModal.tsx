import { useEffect, useRef, useState } from "react";
import { ModalShell } from "./ModalShell";

type Choice = "jira" | "epiku" | "none";

/** The project's tracker choice (#1127): which tracker it reads and, for
 *  Epiku, which Epiku project (empty = the one in Settings). */
export interface TrackerChoice {
  choice: Choice | null;
  epikuProject: string | null;
}

interface Props {
  initialValue: string;
  projectName: string;
  /** With it, the modal also offers Jira / Epiku / None; `epikuDefault` is
   *  the project set in Settings, `epikuConnected` whether Epiku is set up. */
  tracker?: TrackerChoice & { epikuDefault: string | null; epikuConnected: boolean };
  onSave: (value: string | null, tracker?: TrackerChoice) => void;
  onClose: () => void;
}

const CHOICES: { id: Choice; label: string }[] = [
  { id: "jira", label: "Jira" },
  { id: "epiku", label: "Epiku" },
  { id: "none", label: "None" },
];

export function JiraProjectKeyModal({ initialValue, projectName, tracker, onSave, onClose }: Props) {
  const [value, setValue] = useState(initialValue);
  // No choice yet reads as Jira, the default; it stays unset unless changed.
  const [choice, setChoice] = useState<Choice>(tracker?.choice ?? "jira");
  const [epikuProject, setEpikuProject] = useState(tracker?.epikuProject ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const showJira = !tracker || choice === "jira";

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, [choice]);

  function handleSave() {
    const trimmed = value.trim();
    const jiraKey = trimmed === "" ? null : trimmed;
    if (!tracker) return onSave(jiraKey);
    const unchanged = tracker.choice === null && choice === "jira";
    onSave(jiraKey, {
      choice: unchanged ? null : choice,
      epikuProject: choice === "epiku" && epikuProject.trim() !== "" ? epikuProject.trim() : null,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  }

  return (
    <ModalShell onClose={onClose} ariaLabel={tracker ? "Issue tracking" : "Set Jira project key"}>
      <div className="flex w-[400px] flex-col rounded-md border border-octo-hairline bg-octo-panel">
        <div className="flex items-center justify-between border-b border-octo-hairline px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
            {tracker ? "Issue tracking" : "Set Jira project key"}
            {projectName && (
              <>
                {" · "}
                <span className="text-octo-brass">{projectName}</span>
              </>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
          >
            ESC
          </button>
        </div>

        <div className="p-4">
          {tracker && (
            <div role="radiogroup" aria-label="Tracker" data-tour="project-issue-tracker" className="mb-4 flex gap-1.5">
              {CHOICES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={choice === c.id}
                  onClick={() => setChoice(c.id)}
                  className={`rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ${
                    choice === c.id ? "text-octo-brass" : "text-octo-mute hover:text-octo-ivory"
                  }`}
                  style={{
                    background: choice === c.id ? "var(--brass-ghost)" : "transparent",
                    border: `1px solid ${choice === c.id ? "var(--brass-dim)" : "var(--color-octo-hairline)"}`,
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {showJira && (
            <div key="jira" className="octo-fade-in">
              <p className="mb-3 text-[12px] text-octo-sage">
                Enter the Jira project key (e.g. <span className="font-mono text-octo-ivory">PROJ</span>). Leave blank to clear the override.
              </p>
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="PROJ"
                aria-label="Jira project key"
                className="w-full rounded border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[13px] text-octo-ivory outline-none focus:border-octo-brass"
              />
            </div>
          )}
          {tracker && choice === "epiku" && (
            <div key="epiku" className="octo-fade-in">
              <p className="mb-3 text-[12px] text-octo-sage">
                {tracker.epikuConnected
                  ? `Read stories from this Epiku project. Leave blank to use ${tracker.epikuDefault ?? "the one in Settings"}.`
                  : "Connect Epiku in Settings › Integrations › Issue tracking first."}
              </p>
              <input
                ref={inputRef}
                type="text"
                value={epikuProject}
                onChange={(e) => setEpikuProject(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={tracker.epikuDefault ?? "your-project"}
                aria-label="Epiku project"
                className="w-full rounded border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[13px] text-octo-ivory outline-none focus:border-octo-brass"
              />
            </div>
          )}
          {tracker && choice === "none" && (
            <p key="none" className="octo-fade-in text-[12px] text-octo-sage">
              This project shows no tickets and no backlog.
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
              onClick={handleSave}
              className="rounded px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
