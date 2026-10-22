import type { TreeView, VaultView } from './store';

// Store-free on purpose: the openboard bundles use it and must not pull in the store or crypto.

const WEEK = 7 * 86400_000;

export interface VaultStats {
  noteCount: number;
  active7d: number;
  /** 0..1 ink level: share of notes edited this week. */
  level: number;
}

export function vaultStats(vault: VaultView, tree: TreeView | undefined, now = Date.now()): VaultStats {
  let noteCount = vault.noteCount;
  let active7d = vault.activeNoteCount7d;
  if (tree?.status === 'ready') {
    const notes = Object.values(tree.notes);
    noteCount = notes.length;
    active7d = notes.filter((n) => now - Date.parse(n.updatedAt) < WEEK).length;
  }
  const level = Math.max(0, Math.min(1, active7d / Math.max(noteCount, 1)));
  return { noteCount, active7d, level };
}
