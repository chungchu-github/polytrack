/**
 * Disk free-space helpers.
 *
 * Used by:
 *   - boot-time check (warn if dangerously low)
 *   - 6h retention cron (decide whether to trip emergency-aggressive mode)
 *   - backup script (TODO precheck)
 *
 * Built on Node 18+'s `fs.statfs` — synchronous statvfs equivalent. Returns
 * bytes (not blocks) so callers can compare directly to file sizes. Catches
 * any failure (e.g. exotic mounts) and returns null so callers degrade
 * gracefully rather than crashing.
 */
import { statfsSync, statSync } from "fs";

/**
 * Get disk-usage stats for the partition holding `path`.
 *
 * @param {string} path  any file/dir on the target partition
 * @returns {{ totalBytes, freeBytes, usedBytes, usedFrac } | null}
 */
export function getDiskUsage(path) {
  try {
    const s = statfsSync(path);
    // statfs returns bsize, blocks, bfree, bavail (and inode counts)
    const blockSize  = Number(s.bsize)   || 4096;
    const totalBytes = Number(s.blocks)  * blockSize;
    // bavail = blocks free for non-root; that's what we'd actually use.
    const freeBytes  = Number(s.bavail)  * blockSize;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    const usedBytes  = totalBytes - freeBytes;
    const usedFrac   = usedBytes / totalBytes;
    return { totalBytes, freeBytes, usedBytes, usedFrac };
  } catch {
    return null;
  }
}

/**
 * Best-effort size of a file on disk. Returns 0 if missing/unreadable so
 * callers can still compare safely.
 */
export function fileSizeBytes(path) {
  try { return Number(statSync(path).size) || 0; }
  catch { return 0; }
}

/** Pretty-print bytes for log lines. */
export function fmtBytes(b) {
  if (!Number.isFinite(b)) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = Math.max(0, Number(b));
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${u[i]}`;
}
