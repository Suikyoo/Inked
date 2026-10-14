import { act } from 'react';
import { PHONE_QUERY } from '../lib/usePhone';

/**
 * Installs a window.matchMedia that answers the phone query from `set`, reports reduced motion as on
 * (so motion code stays still in tests) and everything else as off. Call `restore` in afterEach.
 */
export function mockPhone(initial: boolean) {
  const original = window.matchMedia;
  let phone = initial;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === PHONE_QUERY ? phone : query.includes('reduce');
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => {
      if (query === PHONE_QUERY) listeners.add(fn);
    },
    removeEventListener: (_: string, fn: () => void) => {
      listeners.delete(fn);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
  return {
    set(v: boolean) {
      phone = v;
      act(() => listeners.forEach((l) => l()));
    },
    restore() {
      window.matchMedia = original;
    },
  };
}
