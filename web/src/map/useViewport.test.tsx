// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCALE, MIN_SCALE, VIEW_ANIM_MS, fit, lerpView, panBy, toScreen, toWorld, useViewport, zoomAt, type View } from './useViewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('viewport maths', () => {
  it('zoomAt keeps the world point under the cursor fixed', () => {
    const v = { scale: 1.3, tx: 40, ty: -20 };
    const w = toWorld(v, { x: 200, y: 150 });
    const s = toScreen(zoomAt(v, 1.7, 200, 150), w);
    expect(s.x).toBeCloseTo(200, 6);
    expect(s.y).toBeCloseTo(150, 6);
  });

  it('clamps scale to 0.4–4 and still keeps the cursor point fixed', () => {
    const v = { scale: 3.5, tx: 0, ty: 0 };
    const z = zoomAt(v, 2, 100, 100);
    expect(z.scale).toBe(MAX_SCALE);
    const s = toScreen(z, toWorld(v, { x: 100, y: 100 }));
    expect(s.x).toBeCloseTo(100, 6);
    expect(zoomAt({ scale: 0.5, tx: 0, ty: 0 }, 0.1, 0, 0).scale).toBe(MIN_SCALE);
  });

  it('fit centres the bounds and scales them into the padded frame', () => {
    const v = fit({ minX: -100, minY: -50, maxX: 300, maxY: 150 }, { w: 800, h: 480 }, 24);
    expect(v.scale).toBeCloseTo(Math.min(752 / 400, 432 / 200), 6);
    const c = toScreen(v, { x: 100, y: 50 });
    expect(c.x).toBeCloseTo(400, 6);
    expect(c.y).toBeCloseTo(240, 6);
    expect(fit({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, { w: 800, h: 480 }).scale).toBe(MAX_SCALE);
  });

  it('panBy shifts and lerpView interpolates', () => {
    expect(panBy({ scale: 2, tx: 1, ty: 2 }, 10, -5)).toEqual({ scale: 2, tx: 11, ty: -3 });
    expect(lerpView({ scale: 1, tx: 0, ty: 0 }, { scale: 3, tx: 10, ty: -10 }, 0.5)).toEqual({ scale: 2, tx: 5, ty: -5 });
  });
});

describe('useViewport animateTo', () => {
  let root: Root;
  let host: HTMLElement;
  let api!: ReturnType<typeof useViewport>;
  function Probe() {
    api = useViewport({ scale: 1, tx: 0, ty: 0 });
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    host = document.createElement('div');
    root = createRoot(host);
    act(() => root.render(<Probe />));
  });
  afterEach(() => {
    act(() => root.unmount());
    delete (window as { matchMedia?: unknown }).matchMedia;
    vi.useRealTimers();
  });

  it('builds a step on the pending target, so quick zoom clicks each land in full', () => {
    const double = (v: View) => ({ ...v, scale: v.scale * 2 });
    act(() => api.animateTo(double));
    act(() => void vi.advanceTimersByTime(100));
    act(() => api.animateTo(double));
    act(() => void vi.advanceTimersByTime(VIEW_ANIM_MS + 100));
    expect(api.view.scale).toBeCloseTo(4, 6);
  });
});
