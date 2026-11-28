import { detectIssueKey } from "./detectIssueKey";

/** The branch a ticket's work lives on: the first local branch whose detected
 *  key is exactly `key`, else the first remote-tracking one, else null. An
 *  exact match, so `ENG-4` never claims `ENG-42`'s branch. Pure. */
export function ticketBranch(local: string[], remote: string[], key: string): string | null {
  const ofTicket = (branch: string) => detectIssueKey(branch) === key;
  return local.find(ofTicket) ?? remote.find(ofTicket) ?? null;
}
