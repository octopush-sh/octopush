/** Prefilling the new-mission setup script from a Conductor repo's
 *  `.conductor/settings.toml` (`[scripts].setup`, read by the backend's
 *  `conductor_setup_script`). Only a prefill: nothing runs until the user
 *  begins the mission. */

/** Whether to look for a Conductor setup script: only while the project has
 *  no remembered setup template (an empty one counts as none). */
export function wantsConductorPrefill(template: string | undefined): boolean {
  return !template?.trim();
}

/** The setup field's visible height, in lines (its `rows`). */
export const SETUP_FIELD_ROWS = 6;

/** The quiet line under a prefilled field. A script longer than the field
 *  says how long it is, so a line far below the fold can't pass unseen.
 *  Octopush sets Conductor's root, workspace path and name for setup scripts,
 *  but allocates no ports, so a script that reads `CONDUCTOR_PORT` gets a note. */
export function conductorSourceLine(script: string): string {
  const parts = ["From .conductor/settings.toml · edit before it runs"];
  const lines = script.split("\n").length;
  if (lines > SETUP_FIELD_ROWS) parts.push(`${lines} lines`);
  if (/\bCONDUCTOR_PORT\b/.test(script)) parts.push("CONDUCTOR_PORT isn't set in Octopush");
  return parts.join(" · ");
}
