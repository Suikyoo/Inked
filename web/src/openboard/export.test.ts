import { describe, expect, it, vi } from 'vitest';
import type { ObFolder, ObNote, ObPayload, ObVault } from 'inked-core';
import { readZip } from '../test/zip';
import { crc32, ExportTargetError, planExport, zipEntries } from './export';

const at = '2026-10-20T10:00:00.000Z';

const vault = (id: string, name: string): ObVault => ({ id, name, color: '#7452e0', updatedAt: at, origin: 'published' });
const folder = (id: string, vaultId: string, parentId: string | null, name: string): ObFolder => ({ id, vaultId, parentId, name });
const note = (id: string, vaultId: string, folderId: string | null, title: string, body: string): ObNote => ({
  id,
  vaultId,
  folderId,
  title,
  body,
  createdAt: at,
  updatedAt: at,
});

function fixture(): ObPayload {
  return {
    vaults: [vault('v1', 'Research')],
    folders: [folder('f1', 'v1', null, 'Ops'), folder('f2', 'v1', 'f1', 'Deep')],
    notes: [
      note('n1', 'v1', null, 'Alpha', 'Alpha body'),
      note('n2', 'v1', 'f1', 'Beta', 'Beta body'),
      note('n3', 'v1', 'f1', 'Index', 'About Ops'),
      note('n4', 'v1', 'f2', 'Gamma', 'Gamma body'),
    ],
  };
}

const paths = (p: { files: { path: string }[] }) => p.files.map((f) => f.path).sort();

describe('planExport', () => {
  it('plans a vault as a zip of nested Markdown files', () => {
    const plan = planExport(fixture(), { kind: 'vault', id: 'v1' });
    expect(plan.kind).toBe('zip');
    if (plan.kind !== 'zip') return;
    expect(plan.filename).toBe('Research.zip');
    expect([...plan.dirs].sort()).toEqual(['Research/', 'Research/Ops/', 'Research/Ops/Deep/']);
    expect(paths(plan)).toEqual([
      'Research/Alpha.md',
      'Research/Ops/Beta.md',
      'Research/Ops/Deep/Gamma.md',
      'Research/Ops/Index.md',
    ]);
    expect(plan.files.find((f) => f.path === 'Research/Alpha.md')!.text).toBe('Alpha body\n');
  });

  it('plans a folder as that folder and its subtree, without ancestors or siblings', () => {
    const plan = planExport(fixture(), { kind: 'folder', id: 'f1' });
    expect(plan.kind).toBe('zip');
    if (plan.kind !== 'zip') return;
    expect(plan.filename).toBe('Ops.zip');
    expect([...plan.dirs].sort()).toEqual(['Ops/', 'Ops/Deep/']);
    expect(paths(plan)).toEqual(['Ops/Beta.md', 'Ops/Deep/Gamma.md', 'Ops/Index.md']);
  });

  it('plans a note as a single Markdown file', () => {
    expect(planExport(fixture(), { kind: 'note', id: 'n1' })).toEqual({ kind: 'note', filename: 'Alpha.md', text: 'Alpha body\n' });
  });

  it('keeps an empty vault as its root folder', () => {
    const payload = { vaults: [vault('v1', 'Empty')], folders: [], notes: [] };
    expect(planExport(payload, { kind: 'vault', id: 'v1' })).toEqual({
      kind: 'zip',
      filename: 'Empty.zip',
      dirs: ['Empty/'],
      files: [],
    });
  });

  it('keeps an empty folder as a directory entry', () => {
    const payload = { vaults: [vault('v1', 'V')], folders: [folder('f1', 'v1', null, 'Empty')], notes: [] };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    expect([...plan.dirs].sort()).toEqual(['V/', 'V/Empty/']);
  });

  it('gives every file a final newline, even an empty note', () => {
    const payload = { vaults: [vault('v1', 'V')], folders: [], notes: [note('n1', 'v1', null, 'Blank', ''), note('n2', 'v1', null, 'Done', 'Done\n')] };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    expect(plan.files.find((f) => f.path === 'V/Blank.md')!.text).toBe('\n');
    expect(plan.files.find((f) => f.path === 'V/Done.md')!.text).toBe('Done\n');
  });

  it('sanitises path characters and Windows-reserved names', () => {
    const payload = {
      vaults: [vault('v1', 'Research: 2026/07')],
      folders: [],
      notes: [
        note('n1', 'v1', null, 'A/B', 'one'),
        note('n2', 'v1', null, 'A-B', 'two'),
        note('n3', 'v1', null, 'CON', 'three'),
        note('n4', 'v1', null, '..', 'four'),
        note('n5', 'v1', null, '', 'five'),
      ],
    };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    expect(plan.filename).toBe('Research- 2026-07.zip');
    const names = paths(plan).map((p) => p.slice('Research- 2026-07/'.length));
    expect(names).toContain('A-B.md');
    expect(names).toContain('A-B (2).md');
    expect(names).toContain('_CON.md');
    expect(names).toContain('Untitled.md');
    expect(names).toContain('Untitled (2).md');
    for (const name of names) expect(name).not.toMatch(/[/\\:]/);
  });

  it('de-duplicates sibling titles case-insensitively and never doubles an .md extension', () => {
    const payload = {
      vaults: [vault('v1', 'V')],
      folders: [],
      notes: [
        note('n1', 'v1', null, 'Dup', 'a'),
        note('n2', 'v1', null, 'Dup', 'b'),
        note('n3', 'v1', null, 'x.md', 'c'),
        note('n4', 'v1', null, 'x', 'd'),
      ],
    };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    const names = paths(plan).map((p) => p.slice(2)).map((n) => n.toLowerCase());
    expect(names.slice().sort()).toEqual(['dup (2).md', 'dup.md', 'x (2).md', 'x.md']);
  });

  it('caps each path segment at a filesystem-safe UTF-8 byte length', () => {
    const long = '漢'.repeat(200); // 600 UTF-8 bytes, past the 255-byte component limit
    const payload = { vaults: [vault('v1', 'V')], folders: [folder('f1', 'v1', null, long)], notes: [note('n1', 'v1', 'f1', long, 'body')] };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    const parts = plan.files[0]!.path.split('/');
    const folderPart = parts[1]!;
    const fileStem = parts[2]!.replace(/\.md$/, '');
    expect(new TextEncoder().encode(folderPart).length).toBeLessThanOrEqual(120);
    expect(new TextEncoder().encode(fileStem).length).toBeLessThanOrEqual(120);
    expect(folderPart.startsWith('漢')).toBe(true);
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(255);
  });

  it('never doubles an .md extension even when spaces hid it from the check', () => {
    const payload = { vaults: [vault('v1', 'V')], folders: [], notes: [note('n1', 'v1', null, 'x.md ', 'body')] };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    expect(paths(plan)).toEqual(['V/x.md']);
  });

  it('keeps a note out of a folder that is not in the same vault without losing it', () => {
    const payload = {
      vaults: [vault('v1', 'V')],
      folders: [],
      notes: [note('n1', 'v1', 'missing', 'Orphan', 'body')],
    };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    expect(paths(plan)).toEqual(['V/Orphan.md']);
  });

  it('terminates on a folder cycle and keeps its notes at the root', () => {
    const payload = {
      vaults: [vault('v1', 'V')],
      folders: [folder('a', 'v1', 'b', 'A'), folder('b', 'v1', 'a', 'B')],
      notes: [note('n1', 'v1', 'a', 'Inside', 'body')],
    };
    const plan = planExport(payload, { kind: 'vault', id: 'v1' });
    if (plan.kind !== 'zip') throw new Error('expected a zip plan');
    expect(plan.dirs).toEqual(['V/']);
    expect(paths(plan)).toEqual(['V/Inside.md']);
  });

  it('rejects a target that is not in the payload', () => {
    expect(() => planExport(fixture(), { kind: 'note', id: 'nope' })).toThrow(ExportTargetError);
    expect(() => planExport(fixture(), { kind: 'folder', id: 'nope' })).toThrow(ExportTargetError);
    expect(() => planExport(fixture(), { kind: 'vault', id: 'nope' })).toThrow(ExportTargetError);
  });
});

describe('zipEntries', () => {
  it('computes the standard CRC-32 vector', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a zip that a reader can walk back to the same entries', async () => {
    const encoder = new TextEncoder();
    const entries = [
      { path: 'V/', data: new Uint8Array() },
      { path: 'V/Alpha.md', data: encoder.encode('Alpha\n') },
      { path: 'V/日本語 ✓.md', data: encoder.encode('Unicode\n') },
    ];
    const zip = await zipEntries(entries, new Date('2026-10-26T12:00:00Z'));
    const read = await readZip(zip);
    expect(read.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    expect(read.map((e) => new TextDecoder().decode(e.data))).toEqual(['', 'Alpha\n', 'Unicode\n']);
    for (const entry of read) {
      expect(entry.flags).toBe(0x0800);
      expect(entry.crc).toBe(crc32(entry.data));
    }
    expect(read[0]!.method).toBe(0);
  });

  it('deflates file data and keeps it much smaller than the input', async () => {
    const text = 'the same line of Markdown over and over\n'.repeat(2000);
    const zip = await zipEntries([{ path: 'V/big.md', data: new TextEncoder().encode(text) }]);
    const [entry] = await readZip(zip);
    expect(entry!.method).toBe(8);
    expect(entry!.data.length).toBe(new TextEncoder().encode(text).length);
    expect(zip.length).toBeLessThan(text.length / 4);
  });

  it('stores data when the platform has no raw DEFLATE', async () => {
    const text = 'a line that would otherwise compress\n'.repeat(1000);
    vi.stubGlobal('CompressionStream', undefined);
    try {
      const zip = await zipEntries([{ path: 'V/big.md', data: new TextEncoder().encode(text) }]);
      const [entry] = await readZip(zip);
      expect(entry!.method).toBe(0);
      expect(new TextDecoder().decode(entry!.data)).toBe(text);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
