/**
 * What each mounted Run terminal shows, readable by id — so Talk's `@session`
 * can attach a session's last lines without a round trip to the PTY daemon.
 * Every TerminalPane stays mounted for the app's lifetime (App.tsx), so a
 * session's xterm buffer is the freshest, already-rendered copy of its
 * output: plain text, with escape sequences already interpreted.
 */

type BufferReader = () => string[];

const readers = new Map<string, BufferReader>();

/** Register a terminal's buffer reader; returns the unregister function. */
export function registerTerminalBuffer(id: string, read: BufferReader): () => void {
  readers.set(id, read);
  return () => {
    if (readers.get(id) === read) readers.delete(id);
  };
}

/** Every line of the terminal's active buffer, or null when it isn't mounted. */
export function readTerminalBuffer(id: string): string[] | null {
  const read = readers.get(id);
  return read ? read() : null;
}
