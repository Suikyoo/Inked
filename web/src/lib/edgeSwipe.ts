import { useEffect, useRef } from 'react';

/** A swipe counts when it starts this close to the left edge… */
export const EDGE_PX = 24;
/** …travels at least this far right… */
export const SWIPE_PX = 56;

export interface Point {
  x: number;
  y: number;
}

/** …and is mostly horizontal (vertical travel at most half the horizontal), so a scroll never opens it. */
export function isEdgeSwipe(start: Point, end: Point): boolean {
  const dx = end.x - start.x;
  return start.x <= EDGE_PX && dx >= SWIPE_PX && Math.abs(end.y - start.y) <= dx / 2;
}

/** Calls `onSwipe` after a swipe in from the left edge. Does nothing while `enabled` is false. */
export function useEdgeSwipe(enabled: boolean, onSwipe: () => void): void {
  const cb = useRef(onSwipe);
  cb.current = onSwipe;
  useEffect(() => {
    if (!enabled) return;
    let start: Point | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (start && t && isEdgeSwipe(start, { x: t.clientX, y: t.clientY })) cb.current();
      start = null;
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
    };
  }, [enabled]);
}
