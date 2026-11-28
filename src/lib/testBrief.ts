/** What the brief reads from a ticket. `description` is the tracker's text,
 *  when it sent one. */
export interface BriefTicket {
  key: string;
  summary: string;
  url?: string | null;
  description?: string | null;
}

/** The opening message of a Test a ticket mission (#1239), seeded into its
 *  Talk composer and sent only when the user sends it. `unread` says the
 *  ticket couldn't be read, so only its key and summary are known. Pure. */
export function testBrief(ticket: BriefTicket, unread = false): string {
  const head = [`Test ${ticket.key}: ${ticket.summary}`, ticket.url].filter(Boolean).join("\n");
  const description = ticket.description?.trim();
  const body = unread
    ? "The ticket's description couldn't be read."
    : description
      ? `Description:\n${description}`
      : "The ticket has no description.";
  const ask =
    "Build it, bring up what it needs to run, follow the test plan above (or derive one from its acceptance criteria), " +
    "and record each command and what it showed. End with a verdict (Works, Doesn't work, or Couldn't test), then the " +
    "evidence, the steps to reproduce any failure, and what you couldn't check.";
  return `${head}\n\n${body}\n\n${ask}`;
}
