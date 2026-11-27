import { detectIssueKey } from "./detectIssueKey";

/** The prefix of the throwaway branch a Test-a-ticket mission makes. */
export const TEST_BRANCH_PREFIX = "test/";

/** The ticket's own branch, to test from: the first local branch whose
 *  detected key is exactly `key`, else the first remote one (`origin/…`),
 *  else null. An earlier test's throwaway `test/<KEY>` is never the ticket's. */
export function ticketBranch(local: string[], remote: string[], key: string): string | null {
  const owns = (name: string) => detectIssueKey(name) === key && !name.startsWith(TEST_BRANCH_PREFIX);
  return local.find(owns) ?? remote.find((b) => owns(b.replace(/^[^/]+\//, ""))) ?? null;
}
