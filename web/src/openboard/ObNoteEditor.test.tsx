// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObNote, ObPayload } from 'inked-core';
import { ObNoteEditor } from './ObNoteEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = '2026-10-20T10:00:00.000Z';

const note = (over: Partial<ObNote> = {}): ObNote => ({
  id: 'n1',
  vaultId: 'v1',
  folderId: null,
  title: 'Alpha',
  body: 'alpha body',
  createdAt: at,
  updatedAt: at,
  ...over,
});

const payload = (notes: ObNote[]): ObPayload => ({
  vaults: [{ id: 'v1', name: 'Research', color: '#7452e0', updatedAt: at, origin: 'published' }],
  folders: [],
  notes,
});

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(over: Partial<Parameters<typeof ObNoteEditor>[0]> = {}) {
  const onSave = over.onSave ?? vi.fn(async (p: { title?: string; body: string }) => note({ ...p, updatedAt: '2026-10-22T10:00:00.000Z' }));
  const onSaved = over.onSaved ?? vi.fn();
  const onCancel = over.onCancel ?? vi.fn();
  const props = {
    note: note(),
    payload: payload([note(), note({ id: 'n2', title: 'Beta', body: 'beta body' })]),
    resolveImage: () => '',
    onSave,
    errorText: (e: unknown) => `failed: ${String(e)}`,
    onSaved,
    onCancel,
    untrustedPreview: false,
    titleMax: 200,
    bodyMax: 1000,
    ...over,
    };
  act(() => root.render(<ObNoteEditor {...props} />));
  return { onSave, onSaved, onCancel };
}

const body = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
const view = () => host.querySelector('.ob-editor-preview');
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;

function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ObNoteEditor', () => {
  it('starts in Edit with the caret at the end of the body', () => {
    mount();
    expect(body()).not.toBeNull();
    expect(view()).toBeNull();
    expect(body().selectionStart).toBe('alpha body'.length);
  });

  it('switches to View and renders the draft, not the saved note', () => {
    mount();
    type(body(), '# Draft heading');
    act(() => button('View').click());
    expect(view()?.querySelector('h1')?.textContent).toBe('Draft heading');
    expect(view()?.textContent).not.toContain('alpha body');
  });

  it('resolves a wiki link in the preview against the live payload', () => {
    mount();
    type(body(), 'see [[Beta]]');
    act(() => button('View').click());
    expect(view()?.querySelector('button.wl')?.textContent).toBe('Beta');
  });

  it('renders an unknown wiki link as plain text', () => {
    mount();
    type(body(), 'see [[Nowhere]]');
    act(() => button('View').click());
    expect(view()?.querySelector('button.wl')).toBeNull();
    expect(view()?.textContent).toContain('Nowhere');
  });

  it('renders a visitor draft as untrusted, so a plain link becomes text', () => {
    mount({ untrustedPreview: true });
    type(body(), '[x](https://example.com)');
    act(() => button('View').click());
    expect(view()?.querySelector('a')).toBeNull();
    expect(view()?.textContent).toContain('x');
  });

  it('keeps the draft across Edit, View and back', () => {
    mount();
    type(body(), 'kept');
    act(() => button('View').click());
    act(() => button('Edit').click());
    expect(body().value).toBe('kept');
  });

  it('reports dirty while the draft differs, and not once it matches again', () => {
    const onDirtyChange = vi.fn();
    mount({ onDirtyChange });
    type(body(), 'changed');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    type(body(), 'alpha body');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('sends a changed title alongside the body', async () => {
    const { onSave } = mount();
    type(host.querySelector<HTMLInputElement>('input')!, 'Renamed');
    await act(async () => button('Save').click());
    expect(onSave).toHaveBeenCalledWith({ title: 'Renamed', body: 'alpha body', baseUpdatedAt: at });
  });

  it('saves the draft and hands back the stored note', async () => {
    const { onSave, onSaved } = mount();
    type(body(), 'new text');
    await act(async () => button('Save').click());
    // An unchanged title is not resent, as the visitor editor has always done.
    expect(onSave).toHaveBeenCalledWith({ body: 'new text', baseUpdatedAt: at });
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows the save error and keeps the draft', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('nope');
    });
    mount({ onSave });
    type(body(), 'new text');
    await act(async () => button('Save').click());
    expect(host.textContent).toContain('failed:');
    expect(body().value).toBe('new text');
  });

  it('keeps an Index note title fixed', () => {
    mount({ note: note({ title: 'Index' }) });
    expect(host.querySelector<HTMLInputElement>('input')!.readOnly).toBe(true);
  });

  it('refuses to save another note under the Index title', () => {
    mount();
    type(host.querySelector<HTMLInputElement>('input')!, 'Index');
    expect(button('Save').disabled).toBe(true);
  });
});
