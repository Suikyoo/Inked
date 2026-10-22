// All SQL for openboard: published plaintext content (and, later, links and payloads).
// Nothing here reads or writes the private encrypted tables.

import { randomUUID } from 'node:crypto';
import { bumpTimestamp, type Db, type ObFolderRow, type ObNoteRow, type ObVaultRow, nowIso, transaction } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { UUID_RE } from '../schemas.js';
import type { ObFolder, ObNote, ObPayload, ObVault, PublishConflict, PublishRequest, PublishResult } from './types.js';

/** A publish that would replace existing content without `overwrite`; maps to 409 with the PublishConflict body. */
export class PublishConflictError extends ApiError {
  constructor(readonly conflict: PublishConflict) {
    super(409, 'conflict', undefined, { target: conflict.target, removes: conflict.removes });
  }
}

const invalid = (message: string) => new ApiError(400, 'invalid_request', message);

/** Image ids (same charset as private image ids) referenced as `inked://<id>`, in first-seen order. */
const IMAGE_REF_RE = new RegExp(`inked://(${UUID_RE.slice(1, -1)})(?![0-9A-Za-z-])`, 'g');

export function imageRefsOf(bodies: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const body of bodies) for (const m of body.matchAll(IMAGE_REF_RE)) seen.add(m[1]);
  return [...seen];
}

/** Checks the request's internal consistency and returns its folders parents-first. */
function orderedFolders(req: PublishRequest): PublishRequest['folders'] {
  if (req.kind === 'vault' && req.rootName !== req.vaultName) throw invalid('rootName must equal vaultName for a vault');
  if (req.kind === 'note') {
    const [note] = req.notes;
    if (req.folders.length !== 0 || req.notes.length !== 1 || note.folderKey !== null || note.title !== req.rootName) {
      throw invalid('A note publish carries exactly one root note titled rootName');
    }
  }
  const byKey = new Map<string, PublishRequest['folders'][number]>();
  for (const f of req.folders) {
    if (byKey.has(f.key)) throw invalid(`Duplicate folder key ${f.key}`);
    byKey.set(f.key, f);
  }
  for (const n of req.notes) {
    if (n.folderKey !== null && !byKey.has(n.folderKey)) throw invalid(`Unknown folder key ${n.folderKey}`);
  }
  const ordered: PublishRequest['folders'] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (f: PublishRequest['folders'][number]) => {
    // Walk up the parent chain iteratively, then emit top-down, so deep trees cannot overflow the stack.
    const chain: PublishRequest['folders'] = [];
    for (let cur: typeof f | undefined = f; cur && state.get(cur.key) !== 'done'; ) {
      if (state.get(cur.key) === 'visiting') throw invalid('Folder parents form a cycle');
      state.set(cur.key, 'visiting');
      chain.push(cur);
      if (cur.parentKey === null) break;
      const parent = byKey.get(cur.parentKey);
      if (!parent) throw invalid(`Unknown folder key ${cur.parentKey}`);
      cur = parent;
    }
    for (const c of chain.reverse()) {
      state.set(c.key, 'done');
      ordered.push(c);
    }
  };
  for (const f of req.folders) visit(f);
  return ordered;
}

const subtreeCte = `
  WITH RECURSIVE sub(id) AS (
    SELECT id FROM ob_folders WHERE vault_id = ? AND parent_id IS ? AND name = ?
    UNION SELECT f.id FROM ob_folders f JOIN sub ON f.parent_id = sub.id
  )`;

/** Drops the vault's images that no note body in the vault references any more. */
function dropUnreferencedImages(db: Db, vaultId: string): void {
  db.prepare(
    `DELETE FROM ob_images WHERE vault_id = ? AND NOT EXISTS (
       SELECT 1 FROM ob_notes n WHERE n.vault_id = ob_images.vault_id AND instr(n.body, 'inked://' || ob_images.id) > 0
     )`,
  ).run(vaultId);
}

function touchVault(db: Db, vaultId: string): void {
  const row = db.prepare('SELECT updated_at FROM ob_vaults WHERE id = ?').get(vaultId) as { updated_at: string };
  db.prepare('UPDATE ob_vaults SET updated_at = ? WHERE id = ?').run(bumpTimestamp(row.updated_at), vaultId);
}

/**
 * Publishes a vault, folder or note subtree in one transaction. The target is found by its name chain
 * (vault name, destPath folder names, root name); sibling duplicates are all part of the target. When the
 * target exists and `overwrite` is false, throws PublishConflictError and changes nothing. Overwrite is a
 * true replace; a vault overwrite keeps the published vault id so link grants survive.
 * `imageQuotaCheck` runs last inside the transaction; throwing from it rolls the whole publish back.
 */
export function publish(
  db: Db,
  userId: string,
  req: PublishRequest,
  imageQuotaCheck?: (vaultId: string) => void,
): PublishResult {
  const folders = orderedFolders(req);
  return transaction(db, () => {
    const now = nowIso();
    const vaults = db
      .prepare('SELECT * FROM ob_vaults WHERE user_id = ? AND name = ? ORDER BY created_at, rowid')
      .all(userId, req.vaultName) as unknown as ObVaultRow[];

    let vaultId: string;
    let rootFolderId: string | null = null;

    if (req.kind === 'vault') {
      if (vaults.length > 0) {
        if (!req.overwrite) {
          const ids = vaults.map((v) => v.id);
          const marks = ids.map(() => '?').join(',');
          const count = (table: string) =>
            (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE vault_id IN (${marks})`).get(...ids) as { n: number }).n;
          throw new PublishConflictError({
            error: 'conflict',
            target: { kind: 'vault', name: req.rootName, path: [] },
            removes: { folders: count('ob_folders'), notes: count('ob_notes') },
          });
        }
        const [keep, ...dups] = vaults;
        for (const d of dups) db.prepare('DELETE FROM ob_vaults WHERE id = ?').run(d.id);
        db.prepare('DELETE FROM ob_notes WHERE vault_id = ?').run(keep.id);
        db.prepare('DELETE FROM ob_folders WHERE vault_id = ?').run(keep.id);
        db.prepare('DELETE FROM ob_images WHERE vault_id = ?').run(keep.id);
        db.prepare('UPDATE ob_vaults SET color = ?, updated_at = ? WHERE id = ?').run(req.color, bumpTimestamp(keep.updated_at), keep.id);
        vaultId = keep.id;
      } else {
        vaultId = randomUUID();
        db.prepare('INSERT INTO ob_vaults (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          vaultId,
          userId,
          req.vaultName,
          req.color,
          now,
          now,
        );
      }
    } else {
      if (vaults.length > 0) {
        vaultId = vaults[0].id;
        touchVault(db, vaultId);
      } else {
        vaultId = randomUUID();
        db.prepare('INSERT INTO ob_vaults (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          vaultId,
          userId,
          req.vaultName,
          req.color,
          now,
          now,
        );
      }

      // Walk (and create where missing) the destination folder chain.
      let parentId: string | null = null;
      for (const name of req.destPath) {
        const found = db
          .prepare('SELECT id FROM ob_folders WHERE vault_id = ? AND parent_id IS ? AND name = ? ORDER BY rowid LIMIT 1')
          .get(vaultId, parentId, name) as { id: string } | undefined;
        if (found) {
          parentId = found.id;
        } else {
          const id = randomUUID();
          db.prepare('INSERT INTO ob_folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)').run(id, vaultId, parentId, name);
          parentId = id;
        }
      }

      const target = { kind: req.kind, name: req.rootName, path: [req.vaultName, ...req.destPath] };
      if (req.kind === 'folder') {
        const args = [vaultId, parentId, req.rootName];
        const removes = {
          folders: (db.prepare(`${subtreeCte} SELECT COUNT(*) AS n FROM sub`).get(...args) as { n: number }).n,
          notes: (
            db.prepare(`${subtreeCte} SELECT COUNT(*) AS n FROM ob_notes WHERE folder_id IN (SELECT id FROM sub)`).get(...args) as {
              n: number;
            }
          ).n,
        };
        if (removes.folders > 0) {
          if (!req.overwrite) throw new PublishConflictError({ error: 'conflict', target, removes });
          // Subfolders and their notes go with it via ON DELETE CASCADE.
          db.prepare('DELETE FROM ob_folders WHERE vault_id = ? AND parent_id IS ? AND name = ?').run(...args);
        }
        rootFolderId = randomUUID();
        db.prepare('INSERT INTO ob_folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)').run(
          rootFolderId,
          vaultId,
          parentId,
          req.rootName,
        );
      } else {
        const args = [vaultId, parentId, req.rootName];
        const notes = (db.prepare('SELECT COUNT(*) AS n FROM ob_notes WHERE vault_id = ? AND folder_id IS ? AND title = ?').get(...args) as {
          n: number;
        }).n;
        if (notes > 0) {
          if (!req.overwrite) throw new PublishConflictError({ error: 'conflict', target, removes: { folders: 0, notes } });
          db.prepare('DELETE FROM ob_notes WHERE vault_id = ? AND folder_id IS ? AND title = ?').run(...args);
        }
        rootFolderId = parentId;
      }
    }

    const keyToId = new Map<string, string>();
    const insFolder = db.prepare('INSERT INTO ob_folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)');
    for (const f of folders) {
      const id = randomUUID();
      keyToId.set(f.key, id);
      insFolder.run(id, vaultId, f.parentKey === null ? rootFolderId : keyToId.get(f.parentKey)!, f.name);
    }
    const insNote = db.prepare(
      'INSERT INTO ob_notes (id, vault_id, folder_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const n of req.notes) {
      insNote.run(randomUUID(), vaultId, n.folderKey === null ? rootFolderId : keyToId.get(n.folderKey)!, n.title, n.body, now, now);
    }

    dropUnreferencedImages(db, vaultId);
    imageQuotaCheck?.(vaultId);
    return { vaultId, imageRefs: imageRefsOf(req.notes.map((n) => n.body)) };
  });
}

const vaultJson = (v: ObVaultRow): ObVault => ({ id: v.id, name: v.name, color: v.color, updatedAt: v.updated_at });
const folderJson = (f: ObFolderRow): ObFolder => ({ id: f.id, vaultId: f.vault_id, parentId: f.parent_id, name: f.name });
const noteJson = (n: ObNoteRow): ObNote => ({
  id: n.id,
  vaultId: n.vault_id,
  folderId: n.folder_id,
  title: n.title,
  body: n.body,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
});

/** Everything the user has published, with note bodies left out (`body: ''`). */
export function listContent(db: Db, userId: string): ObPayload {
  const vaults = db
    .prepare('SELECT * FROM ob_vaults WHERE user_id = ? ORDER BY created_at, rowid')
    .all(userId) as unknown as ObVaultRow[];
  const folders = db
    .prepare('SELECT f.* FROM ob_folders f JOIN ob_vaults v ON v.id = f.vault_id WHERE v.user_id = ? ORDER BY f.rowid')
    .all(userId) as unknown as ObFolderRow[];
  const notes = db
    .prepare(
      `SELECT n.id, n.vault_id, n.folder_id, n.title, '' AS body, n.created_at, n.updated_at
       FROM ob_notes n JOIN ob_vaults v ON v.id = n.vault_id WHERE v.user_id = ? ORDER BY n.rowid`,
    )
    .all(userId) as unknown as ObNoteRow[];
  return { vaults: vaults.map(vaultJson), folders: folders.map(folderJson), notes: notes.map(noteJson) };
}

/** Unpublishes a vault with all its content, images and link grants. 404 unless it is the user's. */
export function deleteVault(db: Db, userId: string, id: string): void {
  const res = db.prepare('DELETE FROM ob_vaults WHERE id = ? AND user_id = ?').run(id, userId);
  if (res.changes === 0) throw notFound();
}

/** Unpublishes a folder with its subfolders and notes. 404 unless it is the user's. */
export function deleteFolder(db: Db, userId: string, id: string): void {
  transaction(db, () => {
    const row = db
      .prepare('SELECT f.vault_id FROM ob_folders f JOIN ob_vaults v ON v.id = f.vault_id WHERE f.id = ? AND v.user_id = ?')
      .get(id, userId) as { vault_id: string } | undefined;
    if (!row) throw notFound();
    db.prepare('DELETE FROM ob_folders WHERE id = ?').run(id);
    touchVault(db, row.vault_id);
    dropUnreferencedImages(db, row.vault_id);
  });
}

/** Unpublishes one note. 404 unless it is the user's. */
export function deleteNote(db: Db, userId: string, id: string): void {
  transaction(db, () => {
    const row = db
      .prepare('SELECT n.vault_id FROM ob_notes n JOIN ob_vaults v ON v.id = n.vault_id WHERE n.id = ? AND v.user_id = ?')
      .get(id, userId) as { vault_id: string } | undefined;
    if (!row) throw notFound();
    db.prepare('DELETE FROM ob_notes WHERE id = ?').run(id);
    touchVault(db, row.vault_id);
    dropUnreferencedImages(db, row.vault_id);
  });
}
