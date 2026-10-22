// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObPublicResponse } from 'inked-core';
import { VisitorPage } from './VisitorPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = '2026-10-20T10:00:00.000Z';
const later = '2026-10-21T10:00:00.000Z';

function payload(): ObPublicResponse {
  return {
    label: 'Reading group',
    vaults: [{ id: 'v1', name: 'Research', color: '#7452e0', updatedAt: later }],
    folders: [{ id: 'f1', vaultId: 'v1', parentId: null, name: 'Ops' }],
    notes: [
      { id: 'n1', vaultId: 'v1', folderId: null, title: 'Alpha', body: '## Alpha heading\n\nSee [[Beta]].', createdAt: at, updatedAt: later },
      { id: 'n2', vaultId: 'v1', folderId: 'f1', title: 'Beta', body: 'Beta body', createdAt: at, updatedAt: at },
      { id: 'n3', vaultId: 'v1', folderId: 'f1', title: 'Foo bar', body: 'Foo body', createdAt: at, updatedAt: at },
      { id: 'ix', vaultId: 'v1', folderId: 'f1', title: 'Index', body: 'About the Ops folder', createdAt: at, updatedAt: at },
    ],
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<VisitorPage />));
  // Let the fetch and its json() settle.
  for (let i = 0; i < 4; i++) await act(async () => {});
}

const q = <T extends Element = HTMLElement>(sel: string) => host!.querySelector<T>(sel);
const qa = (sel: string) => Array.from(host!.querySelectorAll<HTMLElement>(sel));
const label = (r: HTMLElement) => r.querySelector('.ob-row-label')?.textContent?.trim();
const railRows = () => qa('.ob-rail .ob-row-note').map(label);
const railNote = (title: string) => qa('.ob-rail .ob-row-note').find((r) => label(r) === title)!;
const drawer = () => q('.ob-drawer');

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  window.history.replaceState(null, '', '/ob/tok123');
  // Wide enough that the rail starts open.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('VisitorPage', () => {
  it('fetches the token from the path with no credentials and renders the rail and the map', async () => {
    respond(200, payload());
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ob/tok123');
    expect((init as RequestInit).credentials).toBe('omit');
    expect(q('.ob-label')!.textContent).toBe('Reading group');
    expect(q('.ob-rail')!.textContent).toContain('Research');
    expect(q('svg.cmap-svg')).not.toBeNull();
    expect(qa('g.cmap-node').map((n) => n.dataset.note).sort()).toEqual(['n1', 'n2', 'n3']);
    // Visitors get no Ask, no editing controls, no sign-in.
    expect(host!.textContent).not.toMatch(/\bAsk\b|Sign in|New note/);
    expect(drawer()).toBeNull();
  });

  it('clicking a note in the rail opens the drawer with its rendered body and selects it on the map', async () => {
    respond(200, payload());
    await render();
    act(() => railNote('Alpha').click());
    expect(drawer()).not.toBeNull();
    expect(drawer()!.querySelector('h1')!.textContent).toBe('Alpha');
    expect(drawer()!.querySelector('article h2')!.textContent).toBe('Alpha heading');
    expect(q('g.cmap-node[data-note="n1"] .cmap-sel')).not.toBeNull();
    // A [[link]] in the reader opens that note in place.
    act(() => drawer()!.querySelector<HTMLButtonElement>('article button.wl')!.click());
    expect(drawer()!.querySelector('h1')!.textContent).toBe('Beta');
  });

  it('clicking a dot on the map opens the drawer for that note', async () => {
    respond(200, payload());
    await render();
    act(() => q('g.cmap-node[data-note="n3"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(drawer()!.querySelector('h1')!.textContent).toBe('Foo bar');
  });

  it('selecting a folder on the map shows its Index note', async () => {
    respond(200, payload());
    await render();
    act(() => q('g.cmap-folder[data-folder="f1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(drawer()!.querySelector('article')!.textContent).toContain('About the Ops folder');
  });

  it('title search filters the rail rows and highlights hits on the map', async () => {
    respond(200, payload());
    await render();
    expect(railRows()).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Foo bar']));
    type(q<HTMLInputElement>('input[type="search"]')!, 'foo');
    expect(railRows()).toEqual(['Foo bar']);
    expect(q('g.cmap-node[data-note="n3"]')!.classList.contains('is-faded')).toBe(false);
    expect(q('g.cmap-node[data-note="n1"]')!.classList.contains('is-faded')).toBe(true);
  });

  it('Escape closes the drawer', async () => {
    respond(200, payload());
    await render();
    act(() => railNote('Beta').click());
    expect(drawer()).not.toBeNull();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    // The drawer animates out; wait out its exit.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(drawer()).toBeNull();
  });

  it('a 404 renders the not-found page and no map', async () => {
    respond(404, { error: 'not_found' });
    await render();
    expect(host!.textContent).toContain('This link doesn’t exist or was removed.');
    expect(q('svg.cmap-svg')).toBeNull();
    expect(q('.ob-rail')).toBeNull();
  });

  it('a failed fetch is treated as not found', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await render();
    expect(host!.textContent).toContain('This link doesn’t exist or was removed.');
    expect(q('svg.cmap-svg')).toBeNull();
  });

  it('a 429 asks the visitor to wait', async () => {
    respond(429, { error: 'rate_limited' });
    await render();
    expect(host!.textContent).toMatch(/Too many tries/);
    expect(q('svg.cmap-svg')).toBeNull();
  });

  it('a path with no token is not found without fetching', async () => {
    window.history.replaceState(null, '', '/ob/');
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host!.textContent).toContain('This link doesn’t exist or was removed.');
  });

  it('zero vaults renders an empty state, not an error', async () => {
    respond(200, { label: 'Empty', vaults: [], folders: [], notes: [] });
    await render();
    expect(q('.ob-empty')).not.toBeNull();
    expect(host!.textContent).not.toContain('doesn’t exist');
    expect(q('svg.cmap-svg')).toBeNull();
  });

  it('starts with the rail collapsed under 900px wide', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    respond(200, payload());
    await render();
    expect(q('.ob-rail')!.getAttribute('data-collapsed')).toBe('true');
    expect(qa('.ob-rail .ob-row-note')).toHaveLength(0);
    act(() => q<HTMLButtonElement>('.ob-rail-toggle')!.click());
    expect(q('.ob-rail')!.getAttribute('data-collapsed')).toBe('false');
  });
});
