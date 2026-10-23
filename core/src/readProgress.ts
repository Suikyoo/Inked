export type Checkpoint = 0 | 25 | 50 | 75 | 100;

/** A stored read mark: `pct` of a note that was `size` bytes when read. */
export interface ReadMark {
  pct: number;
  size: number;
}

/** Checkpoints a client may store (0 means no mark). */
export const STORED_CHECKPOINTS: readonly number[] = [25, 50, 75, 100];

/** Slack that absorbs ciphertext overhead and tiny edits. */
const SLACK = 0.03;

/** How much of the note the mark covers, in size units, capped at the note's current size. */
export function readCoverage(mark: ReadMark, currentSize: number): number {
  return Math.min((mark.pct / 100) * mark.size, currentSize);
}

/** Coverage wins: `next` replaces `stored` when it covers at least as much (ties go to `next`). */
export function preferRead(stored: ReadMark | null | undefined, next: ReadMark, currentSize: number): ReadMark {
  if (!stored) return next;
  return readCoverage(next, currentSize) >= readCoverage(stored, currentSize) ? next : stored;
}

/** Map a 0..1 fraction to the checkpoint at or below it. */
export function checkpointOf(fraction: number): Checkpoint {
  const f = Math.min(1, Math.max(0, fraction));
  return (Math.floor(f * 4) * 25) as Checkpoint;
}

/** The checkpoint shown for a note given its mark and current size. */
export function shownProgress(mark: ReadMark | null | undefined, currentSize: number): Checkpoint {
  if (!mark) return 0;
  const fraction = ((mark.pct / 100) * mark.size) / Math.max(currentSize, 1);
  return checkpointOf(Math.min(1, Math.max(0, fraction)) + SLACK);
}
