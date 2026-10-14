// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_PX, SWIPE_PX, isEdgeSwipe, useEdgeSwipe } from './edgeSwipe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('isEdgeSwipe', () => {
  it('accepts a long, mostly horizontal drag that starts at the left edge', () => {
    expect(isEdgeSwipe({ x: 5, y: 300 }, { x: 5 + SWIPE_PX, y: 310 })).toBe(true);
  });
  it('rejects a drag that starts away from the edge', () => {
    expect(isEdgeSwipe({ x: EDGE_PX + 1, y: 300 }, { x: 200, y: 300 })).toBe(false);
  });
  it('rejects a short drag', () => {
    expect(isEdgeSwipe({ x: 5, y: 300 }, { x: 5 + SWIPE_PX - 1, y: 300 })).toBe(false);
  });
  it('rejects a mostly vertical drag (a scroll)', () => {
    expect(isEdgeSwipe({ x: 5, y: 100 }, { x: 5 + SWIPE_PX, y: 400 })).toBe(false);
  });
  it('rejects a drag to the left', () => {
    expect(isEdgeSwipe({ x: 5, y: 300 }, { x: -50, y: 300 })).toBe(false);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Probe({ enabled, onSwipe }: { enabled: boolean; onSwipe: () => void }) {
  useEdgeSwipe(enabled, onSwipe);
  return null;
}
function touch(type: 'touchstart' | 'touchend', x: number, y: number) {
  const e = new Event(type, { bubbles: true });
  const t = { clientX: x, clientY: y };
  Object.assign(e, { touches: type === 'touchstart' ? [t] : [], changedTouches: [t] });
  act(() => void document.dispatchEvent(e));
}
function mount(enabled: boolean, onSwipe: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe enabled={enabled} onSwipe={onSwipe} />));
}

describe('useEdgeSwipe', () => {
  it('calls back for an edge swipe', () => {
    const fn = vi.fn();
    mount(true, fn);
    touch('touchstart', 4, 300);
    touch('touchend', 120, 310);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('ignores a swipe that starts mid-screen', () => {
    const fn = vi.fn();
    mount(true, fn);
    touch('touchstart', 150, 300);
    touch('touchend', 300, 300);
    expect(fn).not.toHaveBeenCalled();
  });
  it('does nothing when disabled', () => {
    const fn = vi.fn();
    mount(false, fn);
    touch('touchstart', 4, 300);
    touch('touchend', 120, 300);
    expect(fn).not.toHaveBeenCalled();
  });
});
