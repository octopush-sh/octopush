/** Prefilling the new-mission setup script from a Conductor repo's
 *  `.conductor/settings.toml` (`[scripts].setup`, read by the backend's
 *  `conductor_setup_script`). Only a prefill: nothing runs until the user
 *  begins the mission. */

/** Whether to look for a Conductor setup script: only while the project has
 *  no remembered setup template (an empty one counts as none). */
export function wantsConductorPrefill(template: string | undefined): boolean {
  return !template?.trim();
}

/** The quiet line under a prefilled field. Octopush sets Conductor's root,
 *  workspace path and name for setup scripts, but allocates no ports, so a
 *  script that reads `CONDUCTOR_PORT` gets a note. */
export function conductorSourceLine(script: string): string {
  const base = "From .conductor/settings.toml · edit before it runs";
  return /\bCONDUCTOR_PORT\b/.test(script) ? `${base} · CONDUCTOR_PORT isn't set in Octopush` : base;
}
