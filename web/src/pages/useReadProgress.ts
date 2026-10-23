import { useEffect, type RefObject } from 'react';
import { checkpointOf, type Checkpoint } from 'inked-core';
import { useStore } from '../state/StoreContext';

const HOLD_MS = 1500;
const THROTTLE_MS = 250;

/**
 * How much of the article has scrolled into view, 0..1. A visible article that fits (or was scrolled
 * past) counts as fully read; a hidden (zero-height) article or an empty viewport counts as unread.
 */
export function readFraction(article: { top: number; height: number }, viewport: { top: number; bottom: number }): number {
  if (article.height <= 0 || viewport.bottom <= viewport.top) return 0;
  if (article.top + article.height <= viewport.bottom) return 1;
  return Math.min(1, Math.max(0, (viewport.bottom - article.top) / article.height));
}

/** The nearest ancestor that scrolls on its own, or null when the window does. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

/**
 * Reports 25/50/75/100 reading checkpoints for the rendered note in `articleRef`. A checkpoint
 * counts once the furthest point reached has stood for a short hold and is still on screen when it
 * ends; a `null` target or a `null`
 * size (the body on screen is not the one the size belongs to) turns tracking off.
 */
export function useReadProgress(
  articleRef: RefObject<HTMLElement | null>,
  target: { vaultId: string; noteId: string; size: number | null } | null,
): void {
  const store = useStore();
  const vaultId = target?.vaultId;
  const noteId = target?.noteId;
  const size = target?.size ?? null;

  useEffect(() => {
    const article = articleRef.current;
    if (!article || vaultId === undefined || noteId === undefined || size === null) return;
    const scroller = scrollParent(article);
    const visible = () => document.visibilityState === 'visible';
    let best = 0;
    let reported: Checkpoint = 0;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let throttle: ReturnType<typeof setTimeout> | undefined;

    /** The fraction on screen now; a scroller is clipped to the window. */
    const current = () => {
      const a = article.getBoundingClientRect();
      const s = scroller?.getBoundingClientRect();
      const v = s ? { top: Math.max(s.top, 0), bottom: Math.min(s.bottom, window.innerHeight) } : { top: 0, bottom: window.innerHeight };
      return readFraction({ top: a.top, height: a.height }, v);
    };
    const commit = () => {
      hold = undefined;
      if (!visible()) return;
      // Still there? A fling back up, or late images growing the article, lowers the point reached:
      // that lower point must hold in its own right before it counts.
      const f = current();
      if (checkpointOf(f) < checkpointOf(best)) {
        best = f;
        if (checkpointOf(best) > reported) hold = setTimeout(commit, HOLD_MS);
        return;
      }
      const cp = checkpointOf(best);
      if (cp <= reported) return;
      reported = cp;
      store.markRead(vaultId, noteId, cp, size);
    };
    const measure = () => {
      throttle = undefined;
      if (!visible()) return;
      const f = current();
      const higher = checkpointOf(f) > checkpointOf(best);
      if (higher) best = f;
      // A new, higher checkpoint restarts the hold; so does coming back after one lapsed while hidden.
      if (checkpointOf(best) <= reported || (!higher && hold !== undefined)) return;
      clearTimeout(hold);
      hold = setTimeout(commit, HOLD_MS);
    };
    const schedule = () => {
      throttle ??= setTimeout(measure, THROTTLE_MS);
    };

    const scrollTarget: HTMLElement | Window = scroller ?? window;
    scrollTarget.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    // Images and diagrams change the height after the first paint.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(article);
    measure();
    return () => {
      scrollTarget.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      ro?.disconnect();
      clearTimeout(hold);
      clearTimeout(throttle);
    };
  }, [articleRef, store, vaultId, noteId, size]);
}
