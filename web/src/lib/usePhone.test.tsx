// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { mockPhone } from '../test/phone';
import { PHONE_QUERY, usePhone } from './usePhone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: (() => void) | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  restore?.();
  restore = null;
});

function Probe() {
  return <p data-testid="p">{usePhone() ? 'phone' : 'wide'}</p>;
}
function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return () => host!.textContent;
}

describe('usePhone', () => {
  it('queries the 760px breakpoint the CSS uses', () => {
    expect(PHONE_QUERY).toBe('(max-width: 760px)');
  });

  it('reads the current match, and follows a change after mount', () => {
    const mm = mockPhone(true);
    restore = mm.restore;
    const text = mount();
    expect(text()).toBe('phone');
    mm.set(false);
    expect(text()).toBe('wide');
    mm.set(true);
    expect(text()).toBe('phone');
  });

  it('is false where matchMedia does not exist (jsdom, old browsers)', () => {
    const original = window.matchMedia;
    // @ts-expect-error simulate a missing API
    delete window.matchMedia;
    restore = () => {
      window.matchMedia = original;
    };
    expect(mount()()).toBe('wide');
  });
});
