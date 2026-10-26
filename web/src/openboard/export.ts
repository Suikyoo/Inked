import type { ObFolder, ObNote, ObPayload } from 'inked-core';

/**
 * Openboard export: a vault or folder becomes a zip of Markdown files that mirror the tree; a note becomes
 * one `.md` file. Everything is built in the browser from the payload already on screen — no server calls,
 * no new endpoint. The zip is written here with the platform's own DEFLATE (`CompressionStream`), so no
 * third-party archive library rides in the visitor bundle.
 */

export type ExportTarget = { kind: 'vault'; id: string } | { kind: 'folder'; id: string } | { kind: 'note'; id: string };

export interface ExportFile {
  /** Path inside the zip, always ending in `.md`. */
  path: string;
  text: string;
}

export type ExportPlan =
  | { kind: 'note'; filename: string; text: string }
  | { kind: 'zip'; filename: string; dirs: string[]; files: ExportFile[] };

/** A target that is not in the payload (a link or note removed since the board loaded). */
export class ExportTargetError extends Error {
  constructor() {
    super('Export target not found');
    this.name = 'ExportTargetError';
  }
}

const encoder = new TextEncoder();
// Characters no mainstream filesystem accepts, plus C0/C1 controls.
const UNSAFE = /[/\\:*?"<>|\x00-\x1f\x7f\x80-\x9f]/g;
// DOS device names are refused on Windows even with an extension (`CON.md`).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MD = /\.md$/i;
// A single component is 255 bytes on ext4/APFS and 255 UTF-16 units on Windows. Capping the stem at
// 120 UTF-8 bytes leaves room for " (12).md" and keeps extraction safe on every mainstream filesystem.
const MAX_SEGMENT_BYTES = 120;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const byTitle = (a: ObNote, b: ObNote) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
const withNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** Cuts at a code-point boundary so a multi-byte character can never be split in half. */
function truncateBytes(text: string, max: number): string {
  let used = 0;
  let out = '';
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

/** One path segment as a portable filename: no separators or controls, no trailing dot, not a device name. */
function safeSegment(name: string): string {
  const cleaned = name.replace(UNSAFE, '-').replace(/\s+/g, ' ').trim();
  // A cut can land after a space or dot, which Windows would strip; trim again after truncating.
  const capped = truncateBytes(cleaned, MAX_SEGMENT_BYTES).replace(/[. ]+$/, '');
  if (!capped || capped === '.' || capped === '..') return 'Untitled';
  return WINDOWS_RESERVED.test(capped) ? `_${capped}` : capped;
}

/** A sibling name no other entry in the same directory has (case-insensitively, as macOS/Windows compare). */
function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${n++})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** A note's filename: `.md` exactly once, with a number when a sibling already took the name. */
function uniqueFile(title: string, used: Set<string>): string {
  // Sanitise first: a trailing space would hide the extension from the check, then be trimmed away.
  const stem = safeSegment(safeSegment(title).replace(MD, ''));
  let candidate = `${stem}.md`;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem} (${n++}).md`;
  used.add(candidate.toLowerCase());
  return candidate;
}

interface VaultTree {
  foldersByParent: Map<string | null, ObFolder[]>;
  notesByFolder: Map<string | null, ObNote[]>;
  notes: ObNote[];
}

function buildTrees(payload: ObPayload): Map<string, VaultTree> {
  const trees = new Map<string, VaultTree>();
  for (const v of payload.vaults) trees.set(v.id, { foldersByParent: new Map(), notesByFolder: new Map(), notes: [] });
  for (const f of payload.folders) {
    const tree = trees.get(f.vaultId);
    if (tree) tree.foldersByParent.set(f.parentId, [...(tree.foldersByParent.get(f.parentId) ?? []), f]);
  }
  for (const n of payload.notes) {
    const tree = trees.get(n.vaultId);
    if (!tree) continue;
    tree.notesByFolder.set(n.folderId, [...(tree.notesByFolder.get(n.folderId) ?? []), n]);
    tree.notes.push(n);
  }
  for (const tree of trees.values()) {
    for (const list of tree.foldersByParent.values()) list.sort(byName);
    for (const list of tree.notesByFolder.values()) list.sort(byTitle);
  }
  return trees;
}

/**
 * Plans an export. Throws `ExportTargetError` when the target is not in the payload. Vault and folder
 * plans include every folder in the subtree (so empty folders survive) and every note below it.
 */
export function planExport(payload: ObPayload, target: ExportTarget): ExportPlan {
  if (target.kind === 'note') {
    const note = payload.notes.find((n) => n.id === target.id);
    if (!note) throw new ExportTargetError();
    return { kind: 'note', filename: uniqueFile(note.title, new Set()), text: withNewline(note.body) };
  }

  const trees = buildTrees(payload);
  if (target.kind === 'vault') {
    const vault = payload.vaults.find((v) => v.id === target.id);
    const tree = trees.get(target.id);
    if (!vault || !tree) throw new ExportTargetError();
    const root = `${safeSegment(vault.name)}/`;
    const dirs = [root];
    const files: ExportFile[] = [];
    const seen = new Set<string>();
    const written = new Set<string>();

    const walk = (dirPath: string, parentId: string | null, names: Set<string>) => {
      for (const f of tree.foldersByParent.get(parentId) ?? []) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const child = `${dirPath}${uniqueName(safeSegment(f.name), names)}/`;
        dirs.push(child);
        walk(child, f.id, new Set());
      }
      for (const n of tree.notesByFolder.get(parentId) ?? []) {
        files.push({ path: `${dirPath}${uniqueFile(n.title, names)}`, text: withNewline(n.body) });
        written.add(n.id);
      }
    };
    const rootNames = new Set<string>();
    walk(root, null, rootNames);
    // A note whose folder is missing from the payload would otherwise vanish from its vault's export.
    for (const n of tree.notes) {
      if (written.has(n.id)) continue;
      files.push({ path: `${root}${uniqueFile(n.title, rootNames)}`, text: withNewline(n.body) });
    }
    return { kind: 'zip', filename: `${safeSegment(vault.name)}.zip`, dirs, files };
  }

  const folder = payload.folders.find((f) => f.id === target.id);
  if (!folder) throw new ExportTargetError();
  const tree = trees.get(folder.vaultId);
  if (!tree) throw new ExportTargetError();
  const root = `${safeSegment(folder.name)}/`;
  const dirs = [root];
  const files: ExportFile[] = [];
  const seen = new Set<string>([folder.id]);

  const walk = (dirPath: string, parentId: string | null, names: Set<string>) => {
    for (const f of tree.foldersByParent.get(parentId) ?? []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const child = `${dirPath}${uniqueName(safeSegment(f.name), names)}/`;
      dirs.push(child);
      walk(child, f.id, new Set());
    }
    for (const n of tree.notesByFolder.get(parentId) ?? []) {
      files.push({ path: `${dirPath}${uniqueFile(n.title, names)}`, text: withNewline(n.body) });
    }
  };
  walk(root, folder.id, new Set());
  return { kind: 'zip', filename: `${safeSegment(folder.name)}.zip`, dirs, files };
}

// ---- The ZIP container -----------------------------------------------------------------------
// A store/deflate ZIP with no Zip64 and no encryption: local headers, a central directory, and an EOCD.
// DEFLATE comes from CompressionStream('deflate-raw'); when the browser has no raw-deflate support the
// entries are stored uncompressed instead, which every unzip tool also accepts.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** The standard CRC-32 (the zip checksum). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** A file path, or a directory path ending in `/`. */
  path: string;
  data: Uint8Array<ArrayBuffer>;
}

async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  if (data.length < 64 || typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    // Raw DEFLATE is not in every engine; storing the bytes is still a valid zip.
    return null;
  }
}

function dosStamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return { time, date };
}

function join(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Writes entries as a ZIP. `when` only sets the entries' DOS timestamps (for deterministic tests). */
export async function zipEntries(entries: ZipEntry[], when = new Date()): Promise<Uint8Array<ArrayBuffer>> {
  if (entries.length > 0xffff) throw new Error('Too many files for one zip');
  const stamp = dosStamp(when);
  const parts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (offset > 0xffffffff) throw new Error('Archive too large for a zip without Zip64');
    const name = encoder.encode(entry.path);
    if (name.length > 0xffff) throw new Error('File name too long for a zip');
    const isDir = entry.path.endsWith('/');
    const data = isDir ? new Uint8Array() : entry.data;
    const compressed = await deflateRaw(data);
    const method = compressed ? 8 : 0;
    const body = compressed ?? data;
    if (data.length > 0xffffffff || body.length > 0xffffffff) throw new Error('File too large for a zip without Zip64');
    const sum = crc32(data);
    const version = method === 8 ? 20 : 10;

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, version, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // made by 2.0
    cv.setUint16(6, version, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, isDir ? 0x10 : 0, true); // MS-DOS directory bit
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    parts.push(local);
    centralParts.push(central);
    offset += local.length;
  }

  const centralDirectory = join(centralParts);
  if (offset > 0xffffffff || centralDirectory.length > 0xffffffff) throw new Error('Archive too large for a zip without Zip64');
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirectory.length, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return join([...parts, centralDirectory, end]);
}

/** Builds the plan's zip as bytes. */
async function buildZip(plan: Extract<ExportPlan, { kind: 'zip' }>): Promise<Uint8Array<ArrayBuffer>> {
  return zipEntries([
    ...plan.dirs.map((path) => ({ path, data: new Uint8Array() })),
    ...plan.files.map((f) => ({ path: f.path, data: encoder.encode(f.text) })),
  ]);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Firefox can cancel a download whose blob URL is revoked too soon; a second is plenty.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Downloads a vault, folder or note. Throws `ExportTargetError` when the target is gone. */
export async function exportOpenboard(payload: ObPayload, target: ExportTarget): Promise<void> {
  const plan = planExport(payload, target);
  if (plan.kind === 'note') {
    saveBlob(new Blob([plan.text], { type: 'text/markdown;charset=utf-8' }), plan.filename);
    return;
  }
  const bytes = await buildZip(plan);
  saveBlob(new Blob([bytes], { type: 'application/zip' }), plan.filename);
}
