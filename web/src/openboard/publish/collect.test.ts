import { describe, expect, it, vi } from 'vitest';
import { folder, note, tree, vault } from '../../map/fixtures';
import type { AppState } from '../../state/store';
import { collectUnit, type CollectStore } from './collect';

const IMG = '3f2b8c1e-5d4a-4b6c-9e7f-1a2b3c4d5e6f';

/**
 * Vault "Research" (v1):
 *   Papers/           (f1)
 *     Index           (n1)
 *     Deep/           (f2)
 *       Graphs        (n2)  -> references IMG
 *   Loose             (n3)  (blank title)
 */
function fakeStore(opts: { bodiesLoaded?: boolean } = {}) {
  const t = tree(
    [folder('f1', null, 'Papers'), folder('f2', 'f1', 'Deep')],
    [note('n1', 'f1', 'Index'), note('n2', 'f2', 'Graphs'), note('n3', null, '  ')],
  );
  const allBodies = { n1: 'Papers hub', n2: `See ![chart](inked://${IMG}) and more`, n3: 'loose body' };
  const state = {
    vaults: { v1: { ...vault('v1', 'Research'), color: '#7452e0' } },
    trees: { v1: t },
    bodies: opts.bodiesLoaded === false ? {} : { ...allBodies },
    bodiesReady: { v1: opts.bodiesLoaded !== false },
    bodiesFailed: {},
  } as unknown as AppState;
  const store: CollectStore & { readImage: ReturnType<typeof vi.fn> } = {
    getState: () => state,
    loadTree: vi.fn(async () => undefined),
    loadBodies: vi.fn(async () => {
      state.bodies = { ...allBodies };
      state.bodiesReady = { v1: true };
    }),
    loadNote: vi.fn(async (_v: string, id: string) => ({ body: allBodies[id as keyof typeof allBodies] })),
    readImage: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
  return store;
}

describe('collectUnit', () => {
  it('a vault target returns every folder and note with decrypted bodies, and the referenced images', async () => {
    const store = fakeStore();
    const unit = await collectUnit(store, 'v1', { kind: 'vault' });
    expect(unit.request.kind).toBe('vault');
    expect(unit.request.rootName).toBe('Research');
    expect(unit.request.vaultName).toBe('Research');
    expect(unit.request.color).toBe('#7452e0');
    expect(unit.request.folders).toEqual([
      { key: 'f1', parentKey: null, name: 'Papers' },
      { key: 'f2', parentKey: 'f1', name: 'Deep' },
    ]);
    expect(unit.request.notes).toEqual(
      expect.arrayContaining([
        { folderKey: 'f1', title: 'Index', body: 'Papers hub' },
        { folderKey: 'f2', title: 'Graphs', body: `See ![chart](inked://${IMG}) and more` },
        { folderKey: null, title: 'Untitled', body: 'loose body' },
      ]),
    );
    expect(unit.request.notes).toHaveLength(3);
    expect([...unit.images.keys()]).toEqual([IMG]);
    expect(store.readImage).not.toHaveBeenCalled();
    expect(await unit.images.get(IMG)!()).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.readImage).toHaveBeenCalledWith('v1', IMG);
  });

  it('loads the vault bodies with the store loader when they are not loaded yet', async () => {
    const store = fakeStore({ bodiesLoaded: false });
    const unit = await collectUnit(store, 'v1', { kind: 'vault' });
    expect(store.loadBodies).toHaveBeenCalledWith('v1');
    expect(unit.request.notes.map((n) => n.body).sort()).toEqual(['Papers hub', `See ![chart](inked://${IMG}) and more`, 'loose body'].sort());
  });

  it('a folder target returns only its subtree, rooted at the folder', async () => {
    const unit = await collectUnit(fakeStore(), 'v1', { kind: 'folder', id: 'f1' });
    expect(unit.request.kind).toBe('folder');
    expect(unit.request.rootName).toBe('Papers');
    expect(unit.request.vaultName).toBe('Research');
    expect(unit.request.folders).toEqual([{ key: 'f2', parentKey: null, name: 'Deep' }]);
    expect(unit.request.notes).toEqual(
      expect.arrayContaining([
        { folderKey: null, title: 'Index', body: 'Papers hub' },
        { folderKey: 'f2', title: 'Graphs', body: `See ![chart](inked://${IMG}) and more` },
      ]),
    );
    expect(unit.request.notes).toHaveLength(2);
    expect([...unit.images.keys()]).toEqual([IMG]);
  });

  it('a note target returns that one note and no folders', async () => {
    const unit = await collectUnit(fakeStore(), 'v1', { kind: 'note', id: 'n1' });
    expect(unit.request.kind).toBe('note');
    expect(unit.request.rootName).toBe('Index');
    expect(unit.request.folders).toEqual([]);
    expect(unit.request.notes).toEqual([{ folderKey: null, title: 'Index', body: 'Papers hub' }]);
    expect(unit.images.size).toBe(0);
  });

  it('names a blank note "Untitled", also as the root of a note publish', async () => {
    const unit = await collectUnit(fakeStore(), 'v1', { kind: 'note', id: 'n3' });
    expect(unit.request.rootName).toBe('Untitled');
    expect(unit.request.notes).toEqual([{ folderKey: null, title: 'Untitled', body: 'loose body' }]);
  });

  it('keys are request-local: every folderKey and parentKey refers to a folder in the request', async () => {
    for (const target of [{ kind: 'vault' } as const, { kind: 'folder', id: 'f1' } as const]) {
      const { request } = await collectUnit(fakeStore(), 'v1', target);
      const keys = new Set(request.folders.map((f) => f.key));
      for (const f of request.folders) if (f.parentKey !== null) expect(keys.has(f.parentKey)).toBe(true);
      for (const n of request.notes) if (n.folderKey !== null) expect(keys.has(n.folderKey)).toBe(true);
      // The vault id and the root folder's id never appear in the request.
      expect(JSON.stringify(request)).not.toContain('"v1"');
      if (target.kind === 'folder') expect(keys.has('f1')).toBe(false);
    }
  });
});
