import { formatBytes } from "./formatBytes";

/** Under this much free space the Direct launcher warns; the Readiness card's
 *  disk row turns rouge at the same line (`DISK_FAIL_BYTES` in readiness.rs). */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;

/** The launcher's one amber line, or null while there's room (or no reading:
 *  an unreadable volume reports a total of 0). Never blocks the launch. */
export function lowDiskLine(disk: { freeBytes: number; totalBytes: number } | null | undefined): string | null {
  if (!disk || !(disk.totalBytes > 0) || !(disk.freeBytes < LOW_DISK_BYTES)) return null;
  return `Only ${formatBytes(disk.freeBytes)} free — this run may fail when the disk fills`;
}
