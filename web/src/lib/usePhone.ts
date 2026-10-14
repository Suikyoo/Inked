import { useSyncExternalStore } from 'react';

/** The phone breakpoint. Keep in step with the `max-width: 760px` blocks in styles/*.css (a test checks this). */
export const PHONE_QUERY = '(max-width: 760px)';

const hasMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => undefined;
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

const snapshot = () => hasMatchMedia() && window.matchMedia(PHONE_QUERY).matches;

/** True while the viewport is phone width. False when the browser cannot say. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
