// `tourId("...")` marks a `data-tour` id that is assigned through a variable
// (e.g. one id per mode in a mapped list) rather than a literal
// `data-tour="..."` attribute. It is the identity function at runtime; it
// exists so `scripts/whats-new.mjs check` can find the id (it scans for both
// `data-tour="id"` and `tourId("id")`). Keep the argument a string literal.
export function tourId<T extends string>(id: T): T {
  return id;
}
