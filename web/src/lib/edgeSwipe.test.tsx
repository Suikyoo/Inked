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
function touch(type: 'touchstart' | 'touchend', x: number, y: number, target: EventTarget = document) {
  const e = new Event(type, { bubbles: true });
  const t = { clientX: x, clientY: y };
  Object.assign(e, { touches: type === 'touchstart' ? [t] : [], changedTouches: [t] });
  act(() => void target.dispatchEvent(e));
}
function add(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
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

  it.each([
    ['the concept map', '<div class="cmap"><svg><g id="t"></g></svg></div>'],
    ['a code block', '<pre><code id="t">x</code></pre>'],
    ['a table', '<table><tbody><tr><td id="t">x</td></tr></tbody></table>'],
    ['a text field', '<textarea id="t" spellCheck="false"></textarea>'],
  ])('ignores a swipe that starts on %s', (_name, html) => {
    const fn = vi.fn();
    mount(true, fn);
    const el = add(html);
    const target = el.querySelector('#t')!;
    touch('touchstart', 4, 300, target);
    touch('touchend', 140, 300, target);
    el.remove();
    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores a swipe that starts inside something that scrolls sideways', () => {
    const fn = vi.fn();
    mount(true, fn);
    const el = add('<div id="s" style="overflow-x:auto"><span id="t">x</span></div>');
    const scroller = el.querySelector<HTMLElement>('#s')!;
    Object.defineProperty(scroller, 'scrollWidth', { value: 900 });
    Object.defineProperty(scroller, 'clientWidth', { value: 300 });
    const target = el.querySelector('#t')!;
    touch('touchstart', 4, 300, target);
    touch('touchend', 140, 300, target);
    el.remove();
    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores a swipe while a dialog is open', () => {
    const fn = vi.fn();
    mount(true, fn);
    const el = add('<div role="dialog">x</div>');
    touch('touchstart', 4, 300);
    touch('touchend', 140, 300);
    el.remove();
    expect(fn).not.toHaveBeenCalled();
  });
});