// Visitor writes through a write link: edit a published note, or add one. Only ob_* rows of vaults the
// link grants are touched; nothing here reads or writes the private encrypted tables.

import { randomUUID } from 'node:crypto';
import { bumpTimestamp, type Db, type ObNoteRow, nowIso, transaction } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { isVaultGranted, noteJson, touchVault } from './store.js';
import type { ObNote } from './types.js';

/** Longest visitor-set note title, in characters. */
export const OB_VISITOR_TITLE_MAX = 200;
/** Longest visitor-set note body, in characters. */
export const OB_VISITOR_BODY_MAX = 100_000;
/** A vault refuses a visitor's new note once it holds this many notes. */
export const OB_VISITOR_VAULT_NOTES_MAX = 5000;
/** A vault refuses a visitor write that would take its note text (characters) past this. */
export const OB_VISITOR_VAULT_TEXT_MAX = 32 * 1024 * 1024;

/** A folder's hub note. Visitors cannot add, remove or rename one (they can edit its body). */
const INDEX_TITLE = 'Index';

const invalid = (message: string) => new ApiError(400, 'invalid_request', message);

function checkBody(body: string): void {
  if (body.length > OB_VISITOR_BODY_MAX) throw new ApiError(413, 'too_large', 'Note is too large');
}

/** Refuses a write that would take the vault past its note-text cap; `delta` is the change in characters. */
function checkVaultText(db: Db, vaultId: string, delta: number): void {
  if (delta <= 0) return;
  const { n } = db.prepare('SELECT COALESCE(SUM(length(body)), 0) AS n FROM ob_notes WHERE vault_id = ?').get(vaultId) as { n: number };
  if (n + delta > OB_VISITOR_VAULT_TEXT_MAX) throw new ApiError(413, 'vault_full', 'This vault is full');
}

/**
 * A visitor's edit of a published note's title and/or body. 404 unless the note is in a vault the link
 * grants; 409 `stale` when `baseUpdatedAt` is not the note's current value; Index notes keep their title.
 */
export function editNoteAsVisitor(
  db: Db,
  linkId: string,
  noteId: string,
  req: { baseUpdatedAt: string; title?: string; body?: string },
): ObNote {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM ob_notes WHERE id = ?').get(noteId) as ObNoteRow | undefined;
    if (!row || !isVaultGranted(db, linkId, row.vault_id)) throw notFound();
    if (row.updated_at !== req.baseUpdatedAt) throw new ApiError(409, 'stale', 'The note changed since it was loaded');
    const title = req.title ?? row.title;
    if ((row.title === INDEX_TITLE) !== (title === INDEX_TITLE)) throw invalid('An Index note keeps its title, and no other note can take it');
    const body = req.body ?? row.body;
    checkBody(body);
    checkVaultText(db, row.vault_id, body.length - row.body.length);
    const now = bumpTimestamp(row.updated_at);
    db.prepare('UPDATE ob_notes SET title = ?, body = ?, updated_at = ?, visitor_edited_at = ? WHERE id = ?').run(title, body, now, now, noteId);
    touchVault(db, row.vault_id);
    return noteJson(db.prepare('SELECT * FROM ob_notes WHERE id = ?').get(noteId) as unknown as ObNoteRow);
  });
}

/** A visitor's new note in a granted vault, at its top level or in one of its folders. */
export function createNoteAsVisitor(
  db: Db,
  linkId: string,
  req: { vaultId: string; folderId: string | null; title: string; body: string },
): ObNote {
  return transaction(db, () => {
    if (!isVaultGranted(db, linkId, req.vaultId)) throw notFound();
    if (req.folderId !== null && !db.prepare('SELECT 1 FROM ob_folders WHERE id = ? AND vault_id = ?').get(req.folderId, req.vaultId)) {
      throw invalid('The folder is not in that vault');
    }
    if (req.title === INDEX_TITLE) throw invalid('Index is reserved for folder hubs');
    checkBody(req.body);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM ob_notes WHERE vault_id = ?').get(req.vaultId) as { n: number };
    if (n >= OB_VISITOR_VAULT_NOTES_MAX) throw new ApiError(413, 'vault_full', 'This vault is full');
    checkVaultText(db, req.vaultId, req.body.length);
    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      'INSERT INTO ob_notes (id, vault_id, folder_id, title, body, created_at, updated_at, visitor_edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, req.vaultId, req.folderId, req.title, req.body, now, now, now);
    touchVault(db, req.vaultId);
    return noteJson(db.prepare('SELECT * FROM ob_notes WHERE id = ?').get(id) as unknown as ObNoteRow);
  });
}
