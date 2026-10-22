import type { ObPayload } from 'inked-core';
import { mapEntries, type GraphState, type MapEntry } from '../map/mapEntries';
import type { FolderView, NoteView, TreeView, VaultView } from '../state/store';
import { vaultStats } from '../state/vaultStats';

/**
 * Map entries for published plaintext: one ready entry per vault, in payload order, with every body loaded.
 * Bodies stay raw data here; rendering (and sanitizing) them is the board's job.
 */
export function openboardEntries(payload: ObPayload, now = Date.now()): MapEntry[] {
  const state: GraphState = { vaultOrder: [], vaults: {}, trees: {}, bodies: {}, bodiesReady: {} };
  for (const v of payload.vaults) {
    state.vaultOrder.push(v.id);
    state.trees[v.id] = { status: 'ready', folders: {}, notes: {} };
    state.bodiesReady[v.id] = true;
  }
  const treeOf = (vaultId: string): TreeView | undefined => state.trees[vaultId];
  const stamp = new Map(payload.vaults.map((v) => [v.id, v.updatedAt]));

  for (const f of payload.folders) {
    const tree = treeOf(f.vaultId);
    if (!tree) continue;
    const at = stamp.get(f.vaultId)!;
    const view: FolderView = { id: f.id, vaultId: f.vaultId, parentId: f.parentId, name: f.name, createdAt: at, updatedAt: at };
    tree.folders[f.id] = view;
  }
  for (const n of payload.notes) {
    const tree = treeOf(n.vaultId);
    if (!tree) continue;
    const view: NoteView = { id: n.id, vaultId: n.vaultId, folderId: n.folderId, title: n.title, size: n.body.length, createdAt: n.createdAt, updatedAt: n.updatedAt };
    tree.notes[n.id] = view;
    state.bodies[n.id] = n.body;
  }

  for (const v of payload.vaults) {
    const tree = state.trees[v.id]!;
    const notes = Object.values(tree.notes);
    // The payload has no vault creation time: the oldest note's, else the vault's last update.
    const created = notes.reduce((min, n) => (n.createdAt < min ? n.createdAt : min), v.updatedAt);
    const vault: VaultView = { id: v.id, name: v.name, color: v.color, createdAt: created, updatedAt: v.updatedAt, noteCount: 0, activeNoteCount7d: 0 };
    // The tree is ready, so vaultStats counts from it (the same 7-day rule the hub's ink level uses).
    const stats = vaultStats(vault, tree, now);
    vault.noteCount = stats.noteCount;
    vault.activeNoteCount7d = stats.active7d;
    state.vaults[v.id] = vault;
  }
  // A fresh cache: each payload is laid out once; the board memoizes the result.
  return mapEntries(state, new Map(), now);
}
