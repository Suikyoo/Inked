// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObNote, ObPayload } from 'inked-core';
import { publicImageUrl } from './api';
import { Reader } from './Reader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMG = '0f8fad5b-d9cb-469f-a165-70867728950e';
const at = '2026-10-20T10:00:00.000Z';
const mk = (id: string, title: string, body: string, folderId: string | null = null, vaultId = 'v1'): ObNote => ({
  id,
  vaultId,
  folderId,
  title,
  body,
  createdAt: at,
  updatedAt: at,
});

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(note: ObNote, payload: ObPayload, onOpenNote = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(<Reader note={note} payload={payload} resolveImage={(v, i) => publicImageUrl('tok', v, i)} onOpenNote={onOpenNote} />),
  );
  return onOpenNote;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('Reader', () => {
  it('strips scripts, event-handler attributes and javascript: hrefs', () => {
    const body = [
      '<script>window.__pwned = 1</script>',
      '<img src=x onerror="window.__pwned = 1">',
      '[click](javascript:alert(1))',
      '[enc](JaVaScRiPt:alert(1))',
      '<a href="javascript:alert(1)">raw</a>',
    ].join('\n\n');
    const n = mk('n1', 'Evil', body);
    render(n, { vaults: [{ id: 'v1', name: 'V', color: '#7452e0', updatedAt: at , origin: 'published' }], folders: [], notes: [n] });
    const article = host!.querySelector('article')!;
    expect(article).not.toBeNull();
    expect(host!.querySelector('script')).toBeNull();
    expect(host!.querySelector('[onerror]')).toBeNull();
    for (const a of Array.from(host!.querySelectorAll('a'))) expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('turns inked:// images into public image urls for the note’s vault', () => {
    const n = mk('n1', 'Pic', `![x](inked://${IMG})`, null, 'vault-9');
    render(n, { vaults: [{ id: 'vault-9', name: 'V', color: '#7452e0', updatedAt: at , origin: 'published' }], folders: [], notes: [n] });
    const img = host!.querySelector('article img')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe(`/api/ob/tok/images/vault-9/${IMG}`);
    expect(img.getAttribute('alt')).toBe('x');
  });

  it('[[Title]] to a published note is a button that opens it; an unknown title is plain text', () => {
    const a = mk('n1', 'Alpha', 'See [[Beta]] and [[Nowhere]].');
    const b = mk('n2', 'Beta', 'B');
    const open = render(a, { vaults: [{ id: 'v1', name: 'V', color: '#7452e0', updatedAt: at , origin: 'published' }], folders: [], notes: [a, b] });
    const btn = host!.querySelector<HTMLButtonElement>('article button.wl')!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Beta');
    act(() => btn.click());
    expect(open).toHaveBeenCalledWith('v1', 'n2');
    const article = host!.querySelector('article')!;
    expect(article.textContent).toContain('Nowhere');
    expect(Array.from(article.querySelectorAll('a, button')).some((el) => el.textContent === 'Nowhere')).toBe(false);
  });

  it('a visitor-edited note shows external links as plain text but keeps [[links]] and published images', () => {
    const beta = mk('n2', 'Beta', 'beta');
    const note = { ...mk('n1', 'Alpha', `[click me](https://evil.example) and [home](/v/x/n/y) and [[Beta]] ![pic](inked://${IMG})`), visitorEdited: true };
    render(note, { vaults: [], folders: [], notes: [note, beta] });
    const article = host!.querySelector('article')!;
    expect(article.querySelector('a')).toBeNull();
    expect(article.textContent).toContain('click me');
    expect(article.querySelector('button.wl')!.textContent).toBe('Beta');
    expect(article.querySelector('img')!.getAttribute('src')).toBe(publicImageUrl('tok', 'v1', IMG));
    expect(host!.querySelector('.ob-visitor-tag')!.textContent).toBe('Edited by a visitor');
  });

  it("the owner's own note keeps its external links and has no visitor tag", () => {
    const note = mk('n1', 'Alpha', '[docs](https://example.com)');
    render(note, { vaults: [], folders: [], notes: [note] });
    expect(host!.querySelector('article a')!.getAttribute('href')).toBe('https://example.com');
    expect(host!.querySelector('.ob-visitor-tag')).toBeNull();
  });

  it('shows the note title above the body', () => {
    const n = mk('n1', 'Alpha', 'Body text');
    render(n, { vaults: [{ id: 'v1', name: 'V', color: '#7452e0', updatedAt: at , origin: 'published' }], folders: [], notes: [n] });
    expect(host!.querySelector('h1')!.textContent).toBe('Alpha');
    expect(host!.querySelector('article')!.textContent).toContain('Body text');
  });
});
