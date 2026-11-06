// The one-line note on the Routines list and Mission Control's header when
// the claude.ai sign-in CLI stages and Routines run on ends within 10 days
// (amber) or has ended (rouge). Hidden while nothing is reported — older
// Claude Code versions never say.
import { useEffect } from "react";
import { useClaudeLoginStore } from "../stores/claudeLoginStore";
import { loginNote } from "../lib/claudeLogin";
import { ageLabel } from "../lib/claudePlan";

export const CLAUDE_LOGIN_COMMAND = "claude auth login";

export function ClaudeLoginNote({ tourId, className = "" }: { tourId: string; className?: string }) {
  const login = useClaudeLoginStore((s) => s.login);
  const load = useClaudeLoginStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const note = loginNote(login, now);
  if (!note || !login) return null;
  const tone = note.tone === "ended" ? "text-octo-rouge" : "text-octo-warning";

  return (
    <p
      data-tour={tourId}
      data-testid="claude-login-note"
      data-tone={note.tone}
      className={`octo-rise-in font-mono text-[11px] ${tone} ${className}`}
      title={`From the last Claude Code run, ${ageLabel(login.seenAt, now)}`}
    >
      {note.text} · <span className="text-octo-ivory">{CLAUDE_LOGIN_COMMAND}</span>
    </p>
  );
}
