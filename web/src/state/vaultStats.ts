import type { TreeView, VaultView } from './store';

// Store-free on purpose: the openboard bundles use it and must not pull in the store or crypto.

const WEEK = 7 * 86400_000;

export interface VaultStats {
  noteCount: number;
  active7d: number;
  /** 0..1 ink level: share of notes edited this week. */
  level: number;
}

/** The one definition of "edited this week", which the vault icon's spokes count. */
export const isActive7d = (updatedAt: string, now = Date.now()): boolean => now - Date.parse(updatedAt) < WEEK;

/** Clamped share of `active7d` in `noteCount`: the vault icon's 0..1 ink level. */
export const inkLevel = (active7d: number, noteCount: number): number => Math.max(0, Math.min(1, active7d / Math.max(noteCount, 1)));

/**
 * The ink level of a list of notes. Every surface that draws a VaultIcon goes through here (the sidebar and
 * the map hub via `vaultStats`, the openboard rail and the owner's tree directly), so one rule decides the
 * spoke count everywhere.
 */
export function notesInkLevel(notes: readonly { updatedAt: string }[], now = Date.now()): number {
  return inkLevel(notes.filter((n) => isActive7d(n.updatedAt, now)).length, notes.length);
}

export function vaultStats(vault: VaultView, tree: TreeView | undefined, now = Date.now()): VaultStats {
  let noteCount = vault.noteCount;
  let active7d = vault.activeNoteCount7d;
  if (tree?.status === 'ready') {
    const notes = Object.values(tree.notes);
    noteCount = notes.length;
    active7d = notes.filter((n) => isActive7d(n.updatedAt, now)).length;
  }
  return { noteCount, active7d, level: inkLevel(active7d, noteCount) };
}
