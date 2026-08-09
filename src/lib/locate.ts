/** The sentinel an unmounting file tree registers in place of its real
 *  `locate`, so a parent holding the callback never calls into a dead tree.
 *
 *  It lives here rather than in `CompanionFileTree` because the consumers that
 *  compare against it (ReviewSidebar) are tested with that component mocked —
 *  a named import from a mocked module is an ESM binding error, and a
 *  heuristic on the function itself (arity, name) is satisfied by accident by
 *  ordinary callbacks, `vi.fn()` among them. */
export const NO_LOCATE = (_absPath: string): void => {};
