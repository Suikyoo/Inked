import type { PublishRequest } from 'inked-core';
import { isCryptoError } from 'inked-core/errors';
import type { AppState } from '../../state/store';

// Publishing runs in the notes app, which holds the vault keys: it gathers a vault, folder or note subtree
// as plaintext from the store. Nothing under openboard/visitor or openboard/editor may import this folder.

export type PublishTarget = { kind: 'vault' } | { kind: 'folder'; id: string } | { kind: 'note'; id: string };

/** The part of the notes app store a publish reads. The AppStore satisfies it; tests pass a fake. */
export interface CollectStore {
  getState(): Pick<AppState, 'vaults' | 'trees' | 'bodies' | 'bodiesReady' | 'bodiesFailed'>;
  loadTree(vaultId: string): Promise<void>;
  loadBodies(vaultId: string): Promise<void>;
  loadNote(vaultId: string, noteId: string): Promise<{ body: string }>;
  /** The decrypted bytes of a private image. */
  readImage(vaultId: string, imageId: string): Promise<Uint8Array>;
}

export interface PublishUnit {
  request: Omit<PublishRequest, 'overwrite' | 'destPath'>;
  /** Each image id the published bodies reference, to its lazy fetch-and-decrypt. */
  images: Map<string, () => Promise<Uint8Array>>;
  /** Notes left out because their body could not be read. */
  skipped: number;
}

/** The server rejects empty names. */
const nameOr = (s: string) => (s.trim() ? s : 'Untitled');

/** Openboard colors are `#rrggbb`; anything else falls back to the default ink. */
const colorOr = (c: string) => (/^#[0-9A-Fa-f]{6}$/.test(c) ? c : '#9d7cf2');

/** Same id shape the server extracts from published bodies. */
const IMAGE_REF_RE = /inked:\/\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?![0-9A-Za-z-])/g;

type StoreState = ReturnType<CollectStore['getState']>;

/** The store already knows this note can't be decrypted (its head, or its body in a bulk load). */
const isUnreadable = (s: StoreState, n: { id: string; broken?: boolean }) => !!n.broken || !!s.bodiesFailed[n.id];

/**
 * How many notes in the target's subtree the store already knows are unreadable (left out of a publish).
 * Shown before publishing; `collectUnit`'s `skipped` is the final count.
 */
export function unreadableCount(store: Pick<CollectStore, 'getState'>, vaultId: string, target: PublishTarget): number {
  const s = store.getState();
  const tree = s.trees[vaultId];
  if (!tree) return 0;
  let inScope: (folderId: string | null, noteId: string) => boolean;
  if (target.kind === 'vault') inScope = () => true;
  else if (target.kind === 'note') inScope = (_f, id) => id === target.id;
  else {
    const below = (folderId: string | null): boolean => {
      const seen = new Set<string>();
      for (let id = folderId; id && !seen.has(id); id = tree.folders[id]?.parentId ?? null) {
        if (id === target.id) return true;
        seen.add(id);
      }
      return false;
    };
    inScope = (f) => below(f);
  }
  return Object.values(tree.notes).filter((n) => inScope(n.folderId, n.id) && isUnreadable(s, n)).length;
}

/** The display name of what is being published (for the dialog), or null when it is gone. */
export function targetName(store: Pick<CollectStore, 'getState'>, vaultId: string, target: PublishTarget): string | null {
  const s = store.getState();
  if (target.kind === 'vault') return s.vaults[vaultId] ? nameOr(s.vaults[vaultId].name) : null;
  const t = s.trees[vaultId];
  if (target.kind === 'folder') return t?.folders[target.id] ? nameOr(t.folders[target.id].name) : null;
  return t?.notes[target.id] ? nameOr(t.notes[target.id].title) : null;
}

/**
 * Gathers a publish unit: every folder and note in the target's subtree with decrypted bodies (loading them
 * with the store's own loaders when needed). Folder keys are the private folder ids, request-local only;
 * the target folder itself is the root, so its children sit at key null. Bodies are sent as stored, so
 * image references stay `inked://<id>`.
 */
export async function collectUnit(store: CollectStore, vaultId: string, target: PublishTarget): Promise<PublishUnit> {
  if (!store.getState().vaults[vaultId]) throw new Error('That vault is no longer available.');
  if (store.getState().trees[vaultId]?.status !== 'ready') await store.loadTree(vaultId);
  if (!store.getState().bodiesReady[vaultId]) await store.loadBodies(vaultId);

  const s = store.getState();
  const vault = s.vaults[vaultId];
  const tree = s.trees[vaultId];
  if (!vault || !tree) throw new Error('That vault is no longer available.');

  const childFolders = new Map<string | null, string[]>();
  for (const f of Object.values(tree.folders)) {
    const parent = f.parentId && tree.folders[f.parentId] ? f.parentId : null;
    childFolders.set(parent, [...(childFolders.get(parent) ?? []), f.id]);
  }

  // The folders of the subtree, parents first. `root` is the folder whose children sit at key null.
  let root: string | null = null;
  let rootName: string;
  const folderIds: string[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const id of childFolders.get(parent) ?? []) {
      if (seen.has(id) || id === root) continue;
      seen.add(id);
      folderIds.push(id);
      walk(id);
    }
  };
  if (target.kind === 'vault') {
    rootName = nameOr(vault.name);
    walk(null);
  } else if (target.kind === 'folder') {
    const f = tree.folders[target.id];
    if (!f) throw new Error('That folder no longer exists.');
    root = f.id;
    rootName = nameOr(f.name);
    walk(f.id);
  } else {
    const n = tree.notes[target.id];
    if (!n) throw new Error('That note no longer exists.');
    rootName = nameOr(n.title);
  }

  const inSubtree = new Set(folderIds);
  const keyOf = (folderId: string | null) => (folderId && inSubtree.has(folderId) ? folderId : null);
  const folders = folderIds.map((id) => {
    const f = tree.folders[id];
    return { key: id, parentKey: keyOf(f.parentId), name: nameOr(f.name) };
  });

  const noteHeads = Object.values(tree.notes).filter((n) => {
    if (target.kind === 'note') return n.id === target.id;
    if (target.kind === 'vault') return true;
    return n.folderId === root || (n.folderId !== null && inSubtree.has(n.folderId));
  });

  // Only a note that cannot be decrypted is left out. Any other load failure (network, lock, gone) rejects
  // the whole unit: a partial publish would drop notes, and an overwrite would delete their published copies.
  let skipped = 0;
  const notes: PublishRequest['notes'] = [];
  for (const n of noteHeads) {
    let body: string | undefined = store.getState().bodies[n.id];
    if (body === undefined && !isUnreadable(store.getState(), n)) {
      try {
        body = (await store.loadNote(vaultId, n.id)).body;
      } catch (e) {
        if (!isCryptoError(e, 'decrypt') && !isCryptoError(e, 'format')) throw e;
      }
    }
    if (body === undefined) {
      if (target.kind === 'note') throw new Error('This note couldn’t be read.');
      skipped++;
      continue;
    }
    notes.push({ folderKey: target.kind === 'note' ? null : keyOf(n.folderId), title: nameOr(n.title), body });
  }

  const images = new Map<string, () => Promise<Uint8Array>>();
  for (const n of notes) {
    for (const m of n.body.matchAll(IMAGE_REF_RE)) {
      const id = m[1];
      if (!images.has(id)) images.set(id, () => store.readImage(vaultId, id));
    }
  }

  return {
    request: { kind: target.kind, vaultName: nameOr(vault.name), color: colorOr(vault.color), rootName, folders, notes },
    images,
    skipped,
  };
}
