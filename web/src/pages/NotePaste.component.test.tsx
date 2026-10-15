// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folder, note, tree, vault } from '../map/fixtures';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';

const setBody = vi.hoisted(() => vi.fn());
vi.mock('./useNoteEditor', () => ({
  useNoteEditor: () => ({
    status: 'ready',
    body: 'Some text',
    setBody,
    save: 'idle',
    saveStatus: 'idle',
    loadError: null,
    adoptHead: () => undefined,
    conflict: false,
  }),
}));
import { NotePane } from './NotePane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = '3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c';
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  setBody.mockClear();
});

function mount(store: Partial<AppStore>) {
  const state = {
    vaultsStatus: 'ready',
    vaults: { v1: vault('v1') },
    vaultOrder: ['v1'],
    trees: { v1: tree([folder('f1', null, 'Ops')], [note('n1', 'f1', 'Alpha')]) },
    bodies: { n1: 'Some text' },
    bodiesReady: { v1: true },
    locking: false,
  } as unknown as AppState;
  const full = { getState: () => state, subscribe: () => () => undefined, images: { peek: () => null, get: async () => ({ ok: false }) }, ...store } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[{ pathname: '/v/v1/n/n1', state: { mode: 'edit' } }]}>
        <StoreProvider store={full}>
          <NotePane vault={state.vaults.v1!} noteId="n1" />
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
  return host.querySelector('textarea')!;
}

function clipboardEvent(type: 'paste' | 'drop', files: File[], text = '') {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const data = { files, getData: (t: string) => (t === 'text/plain' ? text : '') };
  Object.defineProperty(e, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data });
  return e;
}
const png = () => new File([new Uint8Array([0x89, 0x50])], 'a.png', { type: 'image/png' });
const flush = () => act(async () => void (await Promise.resolve()));

describe('pasting and dropping images into the editor', () => {
  it('inserts an image token at the caret and uploads in the background', async () => {
    const prepareImage = vi.fn(async () => ({ id: ID, bytes: new Uint8Array([1]) }));
    const uploadImage = vi.fn(async () => undefined);
    const ta = mount({ prepareImage, uploadImage } as Partial<AppStore>);
    ta.setSelectionRange(4, 4);
    const e = clipboardEvent('paste', [png()]);
    await act(async () => void ta.dispatchEvent(e));
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(prepareImage).toHaveBeenCalledWith('v1', expect.any(File));
    expect(setBody).toHaveBeenCalledWith(`Some![](inked://${ID}) text`);
    expect(uploadImage).toHaveBeenCalledWith('v1', { id: ID, bytes: expect.any(Uint8Array) });
  });

  it('leaves a paste that carries text alone', async () => {
    const prepareImage = vi.fn();
    const ta = mount({ prepareImage } as Partial<AppStore>);
    const e = clipboardEvent('paste', [png()], 'a\tb');
    await act(async () => void ta.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(false);
    expect(prepareImage).not.toHaveBeenCalled();
    expect(setBody).not.toHaveBeenCalled();
  });

  it('handles a dropped image file the same way', async () => {
    const prepareImage = vi.fn(async () => ({ id: ID, bytes: new Uint8Array([1]) }));
    const ta = mount({ prepareImage, uploadImage: vi.fn(async () => undefined) } as Partial<AppStore>);
    const e = clipboardEvent('drop', [png()]);
    await act(async () => void ta.dispatchEvent(e));
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(prepareImage).toHaveBeenCalledTimes(1);
  });

  it('shows the reason and inserts nothing when the file is refused', async () => {
    const { ImageRejectedError } = await import('../state/imageStore');
    const prepareImage = vi.fn(async () => {
      throw new ImageRejectedError('That image is larger than 10 MB.');
    });
    const ta = mount({ prepareImage } as Partial<AppStore>);
    await act(async () => void ta.dispatchEvent(clipboardEvent('paste', [png()])));
    await flush();
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('larger than 10 MB');
    expect(setBody).not.toHaveBeenCalled();
  });

  it('removes the token and shows an error when the upload fails', async () => {
    const prepareImage = vi.fn(async () => ({ id: ID, bytes: new Uint8Array([1]) }));
    const uploadImage = vi.fn(async () => {
      throw new Error('boom');
    });
    const ta = mount({ prepareImage, uploadImage } as Partial<AppStore>);
    await act(async () => void ta.dispatchEvent(clipboardEvent('paste', [png()])));
    await flush();
    await flush();
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();
    expect(setBody.mock.calls.at(-1)![0]).not.toContain(`inked://${ID}`);
  });
});
