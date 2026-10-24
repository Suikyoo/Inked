import { describe, expect, it } from 'vitest';
import type { ObPayload } from 'inked-core';
import { openboardEntries } from './entries';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const OLD = '2026-09-01T00:00:00.000Z';
const RECENT = '2026-10-21T00:00:00.000Z';

function payload(): ObPayload {
  return {
    vaults: [
      { id: 'v1', name: 'Research', color: '#9d7cf2', updatedAt: RECENT , origin: 'published' },
      { id: 'v2', name: 'Empty', color: '#55aa88', updatedAt: OLD , origin: 'published' },
    ],
    folders: [
      { id: 'f1', vaultId: 'v1', parentId: null, name: 'Ops' },
      { id: 'f2', vaultId: 'v1', parentId: 'f1', name: 'Runbooks' },
    ],
    notes: [
      { id: 'a', vaultId: 'v1', folderId: 'f1', title: 'A', body: 'See [[B]] and [[Nowhere]].', createdAt: OLD, updatedAt: RECENT },
      { id: 'b', vaultId: 'v1', folderId: 'f2', title: 'B', body: 'plain', createdAt: OLD, updatedAt: OLD },
    ],
  };
}

describe('openboardEntries', () => {
  it('builds one ready entry per vault, in payload order', () => {
    const out = openboardEntries(payload(), NOW);
    expect(out.map((e) => e.vaultId)).toEqual(['v1', 'v2']);
    for (const e of out) {
      expect(e.status).toBe('ready');
      expect(e.graph.linksReady).toBe(true);
    }
    const v1 = out[0]!;
    expect(v1.vault).toMatchObject({ id: 'v1', name: 'Research', color: '#9d7cf2', updatedAt: RECENT, noteCount: 2, activeNoteCount7d: 1 });
    expect(v1.graph.folders.map((f) => [f.id, f.parentId, f.depth])).toEqual([
      ['f1', null, 0],
      ['f2', 'f1', 1],
    ]);
    expect(v1.graph.notes.map((n) => [n.id, n.folderId])).toEqual([
      ['a', 'f1'],
      ['b', 'f2'],
    ]);
  });

  it('a [[Title]] link becomes an edge; a link to a missing title adds none', () => {
    const v1 = openboardEntries(payload(), NOW)[0]!;
    expect(v1.graph.links).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('level is the share of notes edited in the last 7 days (vaultStats)', () => {
    const out = openboardEntries(payload(), NOW);
    expect(out[0]!.level).toBeCloseTo(0.5);
    expect(out[1]!.level).toBe(0);
  });

  it('an empty vault yields an entry with an empty graph', () => {
    const v2 = openboardEntries(payload(), NOW)[1]!;
    expect(v2.vault.noteCount).toBe(0);
    expect(v2.graph.notes).toEqual([]);
    expect(v2.graph.folders).toEqual([]);
    expect(v2.graph.links).toEqual([]);
    expect(v2.layout).toBeDefined();
  });

  it('an empty payload yields no entries', () => {
    expect(openboardEntries({ vaults: [], folders: [], notes: [] }, NOW)).toEqual([]);
  });

  it('duplicate sibling names and non-ASCII names stay distinct nodes', () => {
    const p: ObPayload = {
      vaults: [{ id: 'v1', name: 'Ünïcode 日本', color: '#9d7cf2', updatedAt: OLD , origin: 'published' }],
      folders: [
        { id: 'f1', vaultId: 'v1', parentId: null, name: 'Same' },
        { id: 'f2', vaultId: 'v1', parentId: null, name: 'Same' },
        { id: 'f3', vaultId: 'v1', parentId: null, name: 'Ordner äöü' },
      ],
      notes: [
        { id: 'n1', vaultId: 'v1', folderId: null, title: 'Notiz', body: '', createdAt: OLD, updatedAt: OLD },
        { id: 'n2', vaultId: 'v1', folderId: null, title: 'Notiz', body: '', createdAt: OLD, updatedAt: OLD },
        { id: 'n3', vaultId: 'v1', folderId: 'f3', title: '日本語のノート', body: '[[Notiz]]', createdAt: OLD, updatedAt: OLD },
      ],
    };
    const e = openboardEntries(p, NOW)[0]!;
    expect(e.graph.folders.map((f) => f.id)).toEqual(['f1', 'f2', 'f3']);
    expect(e.graph.notes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
    expect(e.graph.notes.find((n) => n.id === 'n3')!.title).toBe('日本語のノート');
    for (const id of ['n1', 'n2', 'n3']) expect(e.layout.notes[id]).toBeDefined();
    for (const id of ['f1', 'f2', 'f3']) expect(e.layout.folders[id]).toBeDefined();
  });

  it('keeps each vault to its own folders and notes', () => {
    const p = payload();
    p.notes.push({ id: 'c', vaultId: 'v2', folderId: null, title: 'C', body: '[[A]]', createdAt: OLD, updatedAt: OLD });
    const [v1, v2] = openboardEntries(p, NOW);
    expect(v1!.graph.notes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(v2!.graph.notes.map((n) => n.id)).toEqual(['c']);
    // [[A]] is in another vault: no cross-vault edge.
    expect(v2!.graph.links).toEqual([]);
  });

  it('a <script> in a body is plain data here and does not throw', () => {
    const p = payload();
    p.notes[1]!.body = '<script>alert(1)</script> [[A]]';
    const v1 = openboardEntries(p, NOW)[0]!;
    expect(v1.graph.links).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ]);
    expect(p.notes[1]!.body).toBe('<script>alert(1)</script> [[A]]');
  });
});
