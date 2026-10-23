// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../state/StoreContext';
import type { AppStore } from '../state/store';
import { readFraction, useReadProgress } from './useReadProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('readFraction', () => {
  const vp = { top: 0, bottom: 800 };
  it('is 1 when the article fits on screen', () => expect(readFraction({ top: 100, height: 400 }, vp)).toBe(1));
  it('is 0.5 when half has scrolled into view', () => expect(readFraction({ top: -400, height: 2400 }, vp)).toBe(0.5));
  it('is 0 when it has not been reached', () => expect(readFraction({ top: 900, height: 2000 }, vp)).toBe(0));
  it('is 1 for zero height', () => expect(readFraction({ top: 900, height: 0 }, vp)).toBe(1));
});

type Target = { vaultId: string; noteId: string; size: number | null } | null;
function Host({ target }: { target: Target }) {
  const ref = useRef<HTMLElement>(null);
  useReadProgress(ref, target);
  return <article ref={ref}>text</article>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let markRead: ReturnType<typeof vi.fn>;
let rect: { top: number; height: number };
let visibility: DocumentVisibilityState;

function render(target: Target) {
  act(() =>
    root!.render(
      <StoreProvider store={{ markRead } as unknown as AppStore}>
        <Host target={target} />
      </StoreProvider>,
    ),
  );
}
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const t = (noteId = 'n1', size: number | null = 100): Target => ({ vaultId: 'v1', noteId, size });

beforeEach(() => {
  vi.useFakeTimers();
  markRead = vi.fn();
  rect = { top: 100, height: 400 };
  visibility = 'visible';
  window.innerHeight = 800;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ top: rect.top, height: rect.height, bottom: rect.top + rect.height, left: 0, right: 0, width: 0, x: 0, y: rect.top, toJSON: () => ({}) }) as DOMRect,
  );
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useReadProgress', () => {
  it('marks 100 after the hold for a note that fits on screen', () => {
    render(t());
    tick(1400);
    expect(markRead).not.toHaveBeenCalled();
    tick(200);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('v1', 'n1', 100, 100);
  });

  it('does not mark before the hold elapses', () => {
    render(t());
    tick(1000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('a note change before the hold resets it', () => {
    render(t('n1'));
    tick(1000);
    render(t('n2'));
    tick(1000);
    expect(markRead).not.toHaveBeenCalled();
    tick(600);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('v1', 'n2', 100, 100);
  });

  it('size null disables tracking', () => {
    render(t('n1', null));
    tick(5000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('a null target disables tracking', () => {
    render(null);
    tick(5000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('hidden document does not count', () => {
    visibility = 'hidden';
    render(t());
    tick(5000);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('scrolling to halfway marks 50', () => {
    rect = { top: 100, height: 3000 };
    render(t());
    tick(2000);
    expect(markRead).not.toHaveBeenCalled();
    rect = { top: -700, height: 3000 }; // viewport bottom 800 -> 1500/3000
    act(() => void window.dispatchEvent(new Event('scroll')));
    tick(300);
    expect(markRead).not.toHaveBeenCalled();
    tick(1500);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('v1', 'n1', 50, 100);
  });
});
