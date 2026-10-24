// All SQL for openboard: published plaintext content, published images, links and payloads.
// Nothing here reads or writes the private encrypted tables.

import { randomUUID } from 'node:crypto';
import { bumpTimestamp, type Db, type ObFolderRow, type ObNoteRow, type ObVaultRow, nowIso, transaction } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { checkBody, checkVaultNotes, checkVaultText, cleanTitle, INDEX_TITLE, invalid, textDelta } from './write.js';
import { UUID_RE } from '../schemas.js';
import { generateLinkToken } from './token.js';
import type { ObFolder, ObLink, ObNote, ObPayload, ObPermission, ObVault, PublishConflict, PublishRequest, PublishResult } from './types.js';

/** A publish that would replace existing content without `overwrite`; maps to 409 with the PublishConflict body. */
export class PublishConflictError extends ApiError {
  constructor(readonly conflict: PublishConflict) {
    super(409, 'conflict', undefined, {
      target: conflict.target,
      removes: conflict.removes,
      visitorEdits: conflict.visitorEdits,
      ownerEdits: conflict.ownerEdits,
    });
  }
}

/**
 * Whether the user holds an openboard-native vault of this name. Publishing cannot go near one: its notes
 * exist nowhere else, so a name collision is refused instead of resolved by deleting them.
 */
export function nativeVaultNamed(db: Db, userId: string, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM ob_vaults WHERE user_id = ? AND name = ? AND origin = 'native'").get(userId, name);
}

const nameInUse = (name: string) => new ApiError(409, 'name_taken', `You already have an Openboard vault called "${name}".`);

const nameTaken = (name: string) =>
  new ApiError(409, 'name_taken', `"${name}" is a vault you made in Openboard. Rename one of the two before publishing.`);

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

export function touchVault(db: Db, vaultId: string): void {
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
    if (nativeVaultNamed(db, userId, req.vaultName)) throw nameTaken(req.vaultName);
    const vaults = db
      .prepare("SELECT * FROM ob_vaults WHERE user_id = ? AND name = ? AND origin = 'published' ORDER BY created_at, rowid")
      .all(userId, req.vaultName) as unknown as ObVaultRow[];

    let vaultId: string;
    let rootFolderId: string | null = null;

    if (req.kind === 'vault') {
      if (vaults.length > 0) {
        if (!req.overwrite) {
          const ids = vaults.map((v) => v.id);
          const marks = ids.map(() => '?').join(',');
          const count = (table: string, where = '') =>
            (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE vault_id IN (${marks})${where}`).get(...ids) as { n: number }).n;
          throw new PublishConflictError({
            error: 'conflict',
            target: { kind: 'vault', name: req.rootName, path: [] },
            removes: { folders: count('ob_folders'), notes: count('ob_notes') },
            visitorEdits: count('ob_notes', ' AND visitor_edited_at IS NOT NULL'),
            ownerEdits: count('ob_notes', ' AND owner_edited_at IS NOT NULL'),
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
          if (!req.overwrite) {
            const edited = (column: 'visitor_edited_at' | 'owner_edited_at') =>
              (
                db
                  .prepare(`${subtreeCte} SELECT COUNT(*) AS n FROM ob_notes WHERE folder_id IN (SELECT id FROM sub) AND ${column} IS NOT NULL`)
                  .get(...args) as { n: number }
              ).n;
            throw new PublishConflictError({
              error: 'conflict',
              target,
              removes,
              visitorEdits: edited('visitor_edited_at'),
              ownerEdits: edited('owner_edited_at'),
            });
          }
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
        // The target is the note under that title, or the one the owner published under it that a visitor renamed.
        const args = [vaultId, parentId, req.rootName, req.rootName];
        const where = 'vault_id = ? AND folder_id IS ? AND (title = ? OR published_title = ?)';
        const { notes, visitorEdits, ownerEdits } = db
          .prepare(
            `SELECT COUNT(*) AS notes, COUNT(visitor_edited_at) AS visitorEdits, COUNT(owner_edited_at) AS ownerEdits FROM ob_notes WHERE ${where}`,
          )
          .get(...args) as { notes: number; visitorEdits: number; ownerEdits: number };
        if (notes > 0) {
          if (!req.overwrite)
            throw new PublishConflictError({ error: 'conflict', target, removes: { folders: 0, notes }, visitorEdits, ownerEdits });
          db.prepare(`DELETE FROM ob_notes WHERE ${where}`).run(...args);
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
      'INSERT INTO ob_notes (id, vault_id, folder_id, title, body, created_at, updated_at, published_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const n of req.notes) {
      insNote.run(randomUUID(), vaultId, n.folderKey === null ? rootFolderId : keyToId.get(n.folderKey)!, n.title, n.body, now, now, n.title);
    }

    dropUnreferencedImages(db, vaultId);
    imageQuotaCheck?.(vaultId);
    return { vaultId, imageRefs: imageRefsOf(req.notes.map((n) => n.body)) };
  });
}

const vaultJson = (v: ObVaultRow): ObVault => ({ id: v.id, name: v.name, color: v.color, updatedAt: v.updated_at, origin: v.origin });
const folderJson = (f: ObFolderRow): ObFolder => ({ id: f.id, vaultId: f.vault_id, parentId: f.parent_id, name: f.name });
export const noteJson = (n: ObNoteRow): ObNote => ({
  id: n.id,
  vaultId: n.vault_id,
  folderId: n.folder_id,
  title: n.title,
  body: n.body,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
  visitorEdited: n.visitor_edited_at !== null,
  ownerEdited: n.owner_edited_at !== null,
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
      `SELECT n.id, n.vault_id, n.folder_id, n.title, '' AS body, n.created_at, n.updated_at, n.visitor_edited_at
       FROM ob_notes n JOIN ob_vaults v ON v.id = n.vault_id WHERE v.user_id = ? ORDER BY n.rowid`,
    )
    .all(userId) as unknown as ObNoteRow[];
  return { vaults: vaults.map(vaultJson), folders: folders.map(folderJson), notes: notes.map(noteJson) };
}

/** The given published vaults with their folders and notes, bodies included. Unknown ids are skipped. */
export function contentForVaults(db: Db, vaultIds: readonly string[]): ObPayload {
  if (vaultIds.length === 0) return { vaults: [], folders: [], notes: [] };
  const marks = vaultIds.map(() => '?').join(',');
  const vaults = db
    .prepare(`SELECT * FROM ob_vaults WHERE id IN (${marks}) ORDER BY created_at, rowid`)
    .all(...vaultIds) as unknown as ObVaultRow[];
  const folders = db
    .prepare(`SELECT * FROM ob_folders WHERE vault_id IN (${marks}) ORDER BY rowid`)
    .all(...vaultIds) as unknown as ObFolderRow[];
  const notes = db
    .prepare(`SELECT * FROM ob_notes WHERE vault_id IN (${marks}) ORDER BY rowid`)
    .all(...vaultIds) as unknown as ObNoteRow[];
  return { vaults: vaults.map(vaultJson), folders: folders.map(folderJson), notes: notes.map(noteJson) };
}

/**
 * What the owner's visitors would see, with bodies: the link's vaults, or everything the user has
 * published when `linkId` is omitted. Never touches the link's view count. 404 unless the link is the user's.
 */
export function previewContent(db: Db, userId: string, linkId?: string): ObPayload {
  if (linkId === undefined) {
    const rows = db.prepare('SELECT id FROM ob_vaults WHERE user_id = ?').all(userId) as { id: string }[];
    return contentForVaults(db, rows.map((r) => r.id));
  }
  return contentForVaults(db, ownedLink(db, userId, linkId).vaultIds);
}

// ---- Links ----

interface ObLinkRow {
  id: string;
  user_id: string;
  label: string;
  token: string;
  views: number;
  created_at: string;
  permission: ObPermission;
}

/** Attempts at a fresh link token before giving up with 500. */
const TOKEN_ATTEMPTS = 5;

function linkVaultIds(db: Db, linkId: string): string[] {
  const rows = db
    .prepare(
      `SELECT lv.ob_vault_id AS id FROM ob_link_vaults lv JOIN ob_vaults v ON v.id = lv.ob_vault_id
       WHERE lv.link_id = ? ORDER BY v.created_at, v.rowid`,
    )
    .all(linkId) as { id: string }[];
  return rows.map((r) => r.id);
}

const linkJson = (db: Db, row: ObLinkRow): ObLink => ({
  id: row.id,
  label: row.label,
  token: row.token,
  vaultIds: linkVaultIds(db, row.id),
  views: row.views,
  permission: row.permission,
  createdAt: row.created_at,
});

function ownedLink(db: Db, userId: string, id: string): ObLink {
  const row = db.prepare('SELECT * FROM ob_links WHERE id = ? AND user_id = ?').get(id, userId) as ObLinkRow | undefined;
  if (!row) throw notFound();
  return linkJson(db, row);
}

/** De-duplicated vault ids, all of which must be the user's published vaults (else 400). */
function ownedVaultIds(db: Db, userId: string, vaultIds: readonly string[]): string[] {
  const ids = [...new Set(vaultIds)];
  const owned = db.prepare('SELECT 1 FROM ob_vaults WHERE id = ? AND user_id = ?');
  for (const id of ids) if (!owned.get(id, userId)) throw invalid(`Unknown published vault ${id}`);
  return ids;
}

/** Whether the published vault exists and belongs to the user. */
export function ownsVault(db: Db, userId: string, vaultId: string): boolean {
  return !!db.prepare('SELECT 1 FROM ob_vaults WHERE id = ? AND user_id = ?').get(vaultId, userId);
}

function setLinkVaults(db: Db, linkId: string, vaultIds: readonly string[]): void {
  db.prepare('DELETE FROM ob_link_vaults WHERE link_id = ?').run(linkId);
  const ins = db.prepare('INSERT INTO ob_link_vaults (link_id, ob_vault_id) VALUES (?, ?)');
  for (const v of vaultIds) ins.run(linkId, v);
}

const isTokenCollision = (err: unknown) => err instanceof Error && err.message.includes('UNIQUE constraint failed: ob_links.token');

export function listLinks(db: Db, userId: string): ObLink[] {
  const rows = db
    .prepare('SELECT * FROM ob_links WHERE user_id = ? ORDER BY created_at, rowid')
    .all(userId) as unknown as ObLinkRow[];
  return rows.map((r) => linkJson(db, r));
}

/** Creates a link with a fresh token, retrying a token collision up to TOKEN_ATTEMPTS times (then 500). */
export function createLink(
  db: Db,
  userId: string,
  req: { label: string; vaultIds: readonly string[]; permission?: ObPermission },
  newToken: () => string = generateLinkToken,
): ObLink {
  return transaction(db, () => {
    const vaultIds = ownedVaultIds(db, userId, req.vaultIds);
    const id = randomUUID();
    const insert = db.prepare('INSERT INTO ob_links (id, user_id, label, token, views, created_at, permission) VALUES (?, ?, ?, ?, 0, ?, ?)');
    for (let attempt = 1; ; attempt++) {
      try {
        insert.run(id, userId, req.label, newToken(), nowIso(), req.permission ?? 'read');
        break;
      } catch (err) {
        if (!isTokenCollision(err)) throw err;
        if (attempt >= TOKEN_ATTEMPTS) throw new ApiError(500, 'internal', 'Could not generate a unique link token');
      }
    }
    setLinkVaults(db, id, vaultIds);
    return ownedLink(db, userId, id);
  });
}

/** Renames a link, replaces its whole vault set and/or changes its permission, atomically. 404 unless it is the user's. */
export function updateLink(
  db: Db,
  userId: string,
  id: string,
  req: { label?: string; vaultIds?: readonly string[]; permission?: ObPermission },
): ObLink {
  return transaction(db, () => {
    ownedLink(db, userId, id);
    const vaultIds = req.vaultIds === undefined ? undefined : ownedVaultIds(db, userId, req.vaultIds);
    if (req.label !== undefined) db.prepare('UPDATE ob_links SET label = ? WHERE id = ?').run(req.label, id);
    if (vaultIds !== undefined) setLinkVaults(db, id, vaultIds);
    if (req.permission !== undefined) db.prepare('UPDATE ob_links SET permission = ? WHERE id = ?').run(req.permission, id);
    return ownedLink(db, userId, id);
  });
}

/** Deletes a link and its grants. 404 unless it is the user's. */
export function deleteLink(db: Db, userId: string, id: string): void {
  const res = db.prepare('DELETE FROM ob_links WHERE id = ? AND user_id = ?').run(id, userId);
  if (res.changes === 0) throw notFound();
}

// ---- Public (token) access ----

/** The link a public token names, or null. Callers check the token's shape first. */
export function findLinkByToken(
  db: Db,
  token: string,
): { id: string; label: string; userId: string; permission: ObPermission } | null {
  const row = db.prepare('SELECT id, label, user_id, permission FROM ob_links WHERE token = ?').get(token) as
    | { id: string; label: string; user_id: string; permission: ObPermission }
    | undefined;
  return row ? { id: row.id, label: row.label, userId: row.user_id, permission: row.permission } : null;
}

/** The vaults granted to the link, with folders and notes, bodies included. */
export function grantedPayload(db: Db, linkId: string): ObPayload {
  return contentForVaults(db, linkVaultIds(db, linkId));
}

/** True when the published vault is granted to the link. */
export function isVaultGranted(db: Db, linkId: string, vaultId: string): boolean {
  return db.prepare('SELECT 1 FROM ob_link_vaults WHERE link_id = ? AND ob_vault_id = ?').get(linkId, vaultId) !== undefined;
}

/** Counts one public view of the link. */
export function bumpViews(db: Db, linkId: string): void {
  db.prepare('UPDATE ob_links SET views = views + 1 WHERE id = ?').run(linkId);
}

// ---- Images ----

export type ObImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Published images carry the private limit: at most 10 MiB of plaintext. */
export const OB_IMAGE_MAX = 10 * 1024 * 1024;
/** Shorter than the smallest signature check (webp needs 12 bytes) cannot be a real image. */
export const OB_IMAGE_MIN = 12;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The image type from its magic bytes; null for anything that is not png, jpeg, gif or webp (SVG included). */
export function sniffImage(buf: Buffer): ObImageMime | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Bytes the user stores across private (encrypted) and published images; both count against one quota. */
export function imageBytesUsed(db: Db, userId: string): number {
  const row = db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM(i.size), 0) FROM images i JOIN vaults v ON v.id = i.vault_id WHERE v.user_id = ?) +
         (SELECT COALESCE(SUM(o.size), 0) FROM ob_images o JOIN ob_vaults v ON v.id = o.vault_id WHERE v.user_id = ?) AS n`,
    )
    .get(userId, userId) as { n: number };
  return row.n;
}

/**
 * Stores a published image. 404 unless the published vault is the user's and one of its note bodies
 * references `inked://<imageId>`; 409 if it is already stored; 400 unless it sniffs as a supported
 * image; 413 when it would take the user over `quotaBytes`.
 */
export function putImage(
  db: Db,
  userId: string,
  vaultId: string,
  imageId: string,
  data: Buffer,
  quotaBytes: number,
): { id: string; size: number } {
  return transaction(db, () => {
    if (!db.prepare('SELECT 1 FROM ob_vaults WHERE id = ? AND user_id = ?').get(vaultId, userId)) throw notFound();
    if (!imageRefsOf(bodiesReferencing(db, vaultId, imageId)).includes(imageId)) throw notFound();
    if (db.prepare('SELECT 1 FROM ob_images WHERE vault_id = ? AND id = ?').get(vaultId, imageId)) throw new ApiError(409, 'exists');
    const mime = data.length >= OB_IMAGE_MIN ? sniffImage(data) : null;
    if (!mime) throw invalid('Not a supported image (png, jpeg, gif or webp)');
    if (imageBytesUsed(db, userId) + data.length > quotaBytes) throw new ApiError(413, 'quota_exceeded', 'Image storage is full');
    db.prepare('INSERT INTO ob_images (vault_id, id, size, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      vaultId,
      imageId,
      data.length,
      mime,
      data,
      nowIso(),
    );
    return { id: imageId, size: data.length };
  });
}

/** A stored published image's bytes and sniffed mime, or null. */
export function getImage(db: Db, vaultId: string, imageId: string): { mime: ObImageMime; data: Buffer } | null {
  const row = db.prepare('SELECT mime, data FROM ob_images WHERE vault_id = ? AND id = ?').get(vaultId, imageId) as
    | { mime: ObImageMime; data: Uint8Array }
    | undefined;
  return row ? { mime: row.mime, data: Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength) } : null;
}

/** Note bodies in the vault that contain the image id as a substring (candidates for an exact reference). */
function bodiesReferencing(db: Db, vaultId: string, imageId: string): string[] {
  const rows = db
    .prepare('SELECT body FROM ob_notes WHERE vault_id = ? AND instr(body, ?) > 0')
    .all(vaultId, `inked://${imageId}`) as { body: string }[];
  return rows.map((r) => r.body);
}

/**
 * The owner's edit of a published note's title and/or body, straight into the published copy.
 *
 * This deliberately diverges from the private note — nothing copies openboard content back — so the edit is
 * marked with `owner_edited_at` and the next republish of that target warns before discarding it. 404 unless
 * the note is in one of the user's vaults; 409 `stale` when `baseUpdatedAt` is not the current value.
 */
export function editNoteAsOwner(
  db: Db,
  userId: string,
  noteId: string,
  req: { baseUpdatedAt: string; title?: string; body?: string },
): ObNote {
  return transaction(db, () => {
    const row = db
      .prepare('SELECT n.* FROM ob_notes n JOIN ob_vaults v ON v.id = n.vault_id WHERE n.id = ? AND v.user_id = ?')
      .get(noteId, userId) as ObNoteRow | undefined;
    if (!row) throw notFound();
    if (row.updated_at !== req.baseUpdatedAt) throw new ApiError(409, 'stale', 'The note changed since it was loaded');
    const title = req.title === undefined ? row.title : cleanTitle(req.title);
    if ((row.title === INDEX_TITLE) !== (title === INDEX_TITLE)) {
      throw invalid('An Index note keeps its title, and no other note can take it');
    }
    const body = req.body ?? row.body;
    if (body !== row.body) {
      checkBody(body);
      checkVaultText(db, row.vault_id, textDelta(body, row.body));
    }
    const now = bumpTimestamp(row.updated_at);
    db.prepare('UPDATE ob_notes SET title = ?, body = ?, updated_at = ?, owner_edited_at = ? WHERE id = ?').run(title, body, now, now, noteId);
    touchVault(db, row.vault_id);
    return noteJson(db.prepare('SELECT * FROM ob_notes WHERE id = ?').get(noteId) as unknown as ObNoteRow);
  });
}


// ---- Authoring in openboard --------------------------------------------------------------------------------

/** The user's vault of this name, whatever its origin, or undefined. Names are unique per user per origin. */
function vaultNamed(db: Db, userId: string, name: string): ObVaultRow | undefined {
  return db.prepare('SELECT * FROM ob_vaults WHERE user_id = ? AND name = ? ORDER BY created_at, rowid').get(userId, name) as
    | ObVaultRow
    | undefined;
}

/** The user's vault by id, or 404. */
function ownedVaultRow(db: Db, userId: string, id: string): ObVaultRow {
  const row = db.prepare('SELECT * FROM ob_vaults WHERE id = ? AND user_id = ?').get(id, userId) as ObVaultRow | undefined;
  if (!row) throw notFound();
  return row;
}

/**
 * The user's vault by id, refused unless it was authored here.
 *
 * Adding structure to a *published* vault is refused because republishing replaces that vault wholesale and
 * would delete the addition without ever matching it (the design's ruling 9). Editing a note is different:
 * that divergence is contained and the republish warning covers it.
 */
function nativeVaultRow(db: Db, userId: string, id: string): ObVaultRow {
  const row = ownedVaultRow(db, userId, id);
  if (row.origin !== 'native') throw new ApiError(400, 'not_native', 'This vault was published from Inked; edit it there and publish again');
  return row;
}

/** A vault authored in openboard. Its content lives only here, so nothing may later overwrite it by name. */
export function createNativeVault(db: Db, userId: string, req: { name: string; color: string }): ObVault {
  return transaction(db, () => {
    const name = cleanTitle(req.name);
    if (vaultNamed(db, userId, name)) throw nameInUse(name);
    const id = randomUUID();
    const now = nowIso();
    db.prepare("INSERT INTO ob_vaults (id, user_id, name, color, created_at, updated_at, origin) VALUES (?, ?, ?, ?, ?, ?, 'native')").run(
      id,
      userId,
      name,
      req.color,
      now,
      now,
    );
    return vaultJson(ownedVaultRow(db, userId, id));
  });
}

/** Renames or recolours a native vault. */
export function updateNativeVault(db: Db, userId: string, id: string, patch: { name?: string; color?: string }): ObVault {
  return transaction(db, () => {
    const row = nativeVaultRow(db, userId, id);
    const name = patch.name === undefined ? row.name : cleanTitle(patch.name);
    if (name !== row.name && vaultNamed(db, userId, name)) throw nameInUse(name);
    db.prepare('UPDATE ob_vaults SET name = ?, color = ?, updated_at = ? WHERE id = ?').run(
      name,
      patch.color ?? row.color,
      bumpTimestamp(row.updated_at),
      id,
    );
    return vaultJson(ownedVaultRow(db, userId, id));
  });
}

/** A folder in a native vault, at its root or under one of its folders. */
export function createOwnerFolder(db: Db, userId: string, req: { vaultId: string; parentId: string | null; name: string }): ObFolder {
  return transaction(db, () => {
    nativeVaultRow(db, userId, req.vaultId);
    if (req.parentId !== null && !db.prepare('SELECT 1 FROM ob_folders WHERE id = ? AND vault_id = ?').get(req.parentId, req.vaultId)) {
      throw invalid('The parent folder is not in that vault');
    }
    const id = randomUUID();
    db.prepare('INSERT INTO ob_folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)').run(id, req.vaultId, req.parentId, cleanTitle(req.name));
    touchVault(db, req.vaultId);
    return folderJson(db.prepare('SELECT * FROM ob_folders WHERE id = ?').get(id) as unknown as ObFolderRow);
  });
}

/** Renames a folder in a native vault. */
export function renameOwnerFolder(db: Db, userId: string, id: string, name: string): ObFolder {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM ob_folders WHERE id = ?').get(id) as ObFolderRow | undefined;
    if (!row) throw notFound();
    nativeVaultRow(db, userId, row.vault_id);
    db.prepare('UPDATE ob_folders SET name = ? WHERE id = ?').run(cleanTitle(name), id);
    touchVault(db, row.vault_id);
    return folderJson(db.prepare('SELECT * FROM ob_folders WHERE id = ?').get(id) as unknown as ObFolderRow);
  });
}

/**
 * A note in a native vault. `published_title` stays null, as it does for a note a visitor added: this note was
 * never published from anywhere, so a republish has nothing to match it against.
 */
export function createOwnerNote(
  db: Db,
  userId: string,
  req: { vaultId: string; folderId: string | null; title: string; body: string },
): ObNote {
  return transaction(db, () => {
    nativeVaultRow(db, userId, req.vaultId);
    if (req.folderId !== null && !db.prepare('SELECT 1 FROM ob_folders WHERE id = ? AND vault_id = ?').get(req.folderId, req.vaultId)) {
      throw invalid('The folder is not in that vault');
    }
    const title = cleanTitle(req.title);
    if (title === INDEX_TITLE) throw invalid('Index is reserved for folder hubs');
    checkBody(req.body);
    checkVaultNotes(db, req.vaultId);
    checkVaultText(db, req.vaultId, textDelta(req.body, ''));
    const id = randomUUID();
    const now = nowIso();
    // owner_edited_at stays null: it marks a *published* copy the owner changed, which republishing would
    // discard. A note authored here was never published from anywhere, so there is nothing to warn about.
    db.prepare('INSERT INTO ob_notes (id, vault_id, folder_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      req.vaultId,
      req.folderId,
      title,
      req.body,
      now,
      now,
    );
    touchVault(db, req.vaultId);
    return noteJson(db.prepare('SELECT * FROM ob_notes WHERE id = ?').get(id) as unknown as ObNoteRow);
  });
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
