// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../state/StoreContext';
import type { AppStore } from '../state/store';
import { useInkedImages } from './useInkedImages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = '3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c';
const html = (alt = 'a chart') => `<p>hi <img data-inked-image="${ID}" alt="${alt}"></p>`;

function Host({ markup }: { markup: string }) {
  const ref = useRef<HTMLElement>(null);
  useInkedImages(ref, 'v1', markup);
  return <article ref={ref} dangerouslySetInnerHTML={{ __html: markup }} />;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

async function mount(images: { peek: (v: string, i: string) => string | null; get: (v: string, i: string) => Promise<unknown> }, markup = html()) {
  const store = { images } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <StoreProvider store={store}>
        <Host markup={markup} />
      </StoreProvider>,
    );
  });
  return host;
}

describe('useInkedImages', () => {
  it('sets the src from the store once the image resolves', async () => {
    const get = vi.fn(async () => ({ ok: true, url: 'blob:test/1' }));
    const el = await mount({ peek: () => null, get });
    expect(get).toHaveBeenCalledWith('v1', ID);
    expect(el.querySelector('img')!.getAttribute('src')).toBe('blob:test/1');
  });
  it('uses a cached url at once, without waiting', async () => {
    const get = vi.fn();
    const el = await mount({ peek: () => 'blob:cached', get });
    expect(el.querySelector('img')!.getAttribute('src')).toBe('blob:cached');
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    ['resolved', { peek: () => null, get: async () => ({ ok: true, url: 'blob:bad' }) }],
    ['cached', { peek: () => 'blob:bad', get: vi.fn() }],
  ])('replaces a %s image that fails to decode with the unavailable box', async (_n, images) => {
    const el = await mount(images);
    const img = el.querySelector('img')!;
    await act(async () => {
      img.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.img-unavailable')).not.toBeNull();
  });
  it('replaces a missing, foreign or corrupt image with an unavailable box and leaves the rest of the note', async () => {
    const el = await mount({ peek: () => null, get: async () => ({ ok: false }) });
    expect(el.querySelector('img')).toBeNull();
    const box = el.querySelector('.img-unavailable')!;
    expect(box.textContent).toBe('Image unavailable');
    expect(box.getAttribute('aria-label')).toBe('Image unavailable: a chart');
    expect(el.querySelector('p')!.textContent).toContain('hi');
  });
  it('does not touch the DOM when unmounted before the image resolves', async () => {
    let release!: (v: unknown) => void;
    const get = vi.fn(() => new Promise((r) => (release = r)));
    const el = await mount({ peek: () => null, get });
    const img = el.querySelector('img')!;
    act(() => root!.unmount());
    root = null;
    await act(async () => release({ ok: true, url: 'blob:late' }));
    expect(img.getAttribute('src')).toBeNull();
  });
});
