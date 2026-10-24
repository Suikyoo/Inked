// Visitor writes through a write link: edit a published note, or add one. Only ob_* rows of vaults the
// link grants are touched; nothing here reads or writes the private encrypted tables.

import { randomUUID } from 'node:crypto';
import { bumpTimestamp, type Db, type ObNoteRow, nowIso, transaction } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { isVaultGranted, noteJson, touchVault } from './store.js';
import type { ObNote } from './types.js';
import {
  checkBody,
  checkVaultNotes,
  checkVaultText,
  cleanTitle,
  INDEX_TITLE,
  invalid,
  OB_WRITE_BODY_MAX,
  OB_WRITE_TITLE_MAX,
  OB_VAULT_NOTES_MAX,
  OB_VAULT_TEXT_MAX,
  textDelta,
} from './write.js';

// The caps are the same for every writer; these names are what the routes and the web client already use.
export const OB_VISITOR_TITLE_MAX = OB_WRITE_TITLE_MAX;
export const OB_VISITOR_BODY_MAX = OB_WRITE_BODY_MAX;
export const OB_VISITOR_VAULT_NOTES_MAX = OB_VAULT_NOTES_MAX;
export const OB_VISITOR_VAULT_TEXT_MAX = OB_VAULT_TEXT_MAX;

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
    const title = req.title === undefined ? row.title : cleanTitle(req.title);
    if ((row.title === INDEX_TITLE) !== (title === INDEX_TITLE)) throw invalid('An Index note keeps its title, and no other note can take it');
    const body = req.body ?? row.body;
    // An unchanged body is not re-checked, so a visitor can retitle an owner note longer than the visitor limit.
    if (body !== row.body) {
      checkBody(body);
      checkVaultText(db, row.vault_id, textDelta(body, row.body));
    }
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
    const title = cleanTitle(req.title);
    if (title === INDEX_TITLE) throw invalid('Index is reserved for folder hubs');
    checkBody(req.body);
    checkVaultNotes(db, req.vaultId);
    checkVaultText(db, req.vaultId, textDelta(req.body, ''));
    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      'INSERT INTO ob_notes (id, vault_id, folder_id, title, body, created_at, updated_at, visitor_edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, req.vaultId, req.folderId, title, req.body, now, now, now);
    touchVault(db, req.vaultId);
    return noteJson(db.prepare('SELECT * FROM ob_notes WHERE id = ?').get(id) as unknown as ObNoteRow);
  });
}
