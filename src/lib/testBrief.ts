import type { Issue } from "./types";

/** What a Test-a-ticket brief needs of the ticket. A ticket that couldn't be
 *  read gives only its key and summary. */
export type BriefTicket = Pick<Issue, "key" | "summary"> & Partial<Pick<Issue, "url" | "description">>;

/** The ask that closes every brief. */
export const TEST_ASK =
  "Build it, bring up what it needs to run, follow the test plan above (or derive one from its acceptance criteria), " +
  "record each command and what it showed, and end with a verdict (Works, Doesn't work, or Couldn't test), then the " +
  "evidence, the steps to reproduce any failure, and what you couldn't check.";

/** The draft a Test-a-ticket mission's Talk composer starts with: the
 *  ticket, its description, and the ask. `read` is false when the ticket
 *  couldn't be read, so the brief says the description is missing. Nothing
 *  is sent until the user sends it. */
export function testBrief(ticket: BriefTicket, read = true): string {
  const head = [`Test ${ticket.key}: ${ticket.summary}`];
  if (ticket.url) head.push(ticket.url);
  const description = ticket.description?.trim();
  const body = !read
    ? "The ticket's description couldn't be read."
    : description
      ? `Description:\n${description}`
      : "The ticket has no description.";
  return [head.join("\n"), body, TEST_ASK].join("\n\n");
}
