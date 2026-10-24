// Rules every write to published (plaintext) openboard content obeys, whoever makes it: a visitor through a
// write link, or the owner from the openboard control. The caps exist to protect the server's disk and the
// reader's browser, and those are the same whoever is typing.

import type { Db } from '../db.js';
import { ApiError } from '../errors.js';

/** Longest note title an interactive write may set, in characters. */
export const OB_WRITE_TITLE_MAX = 200;
/** Longest note body an interactive write may set. Publishing has its own, larger cap. */
export const OB_WRITE_BODY_MAX = 100_000;
/** A vault refuses a new note once it holds this many. */
export const OB_VAULT_NOTES_MAX = 5000;
/** A vault refuses a write that would take its note text (UTF-8 bytes) past this. */
export const OB_VAULT_TEXT_MAX = 32 * 1024 * 1024;

/** A folder's hub note. Nobody can add, remove or rename one through these routes. */
export const INDEX_TITLE = 'Index';

export const invalid = (message: string) => new ApiError(400, 'invalid_request', message);

/** Control characters, line and paragraph separators, and bidi overrides and isolates. */
const BAD_TITLE_CHARS = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** The title as stored: trimmed, with no control or bidi characters (else 400). */
export function cleanTitle(title: string): string {
  const t = title.trim();
  if (!t || BAD_TITLE_CHARS.test(t)) throw invalid('Titles are one line of plain text');
  return t;
}

export function checkBody(body: string): void {
  if (body.length > OB_WRITE_BODY_MAX) throw new ApiError(413, 'too_large', 'Note is too large');
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** Refuses a write that would take the vault past its note-text cap; `delta` is the change in UTF-8 bytes. */
export function checkVaultText(db: Db, vaultId: string, delta: number): void {
  if (delta <= 0) return;
  const { n } = db.prepare('SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS n FROM ob_notes WHERE vault_id = ?').get(vaultId) as {
    n: number;
  };
  if (n + delta > OB_VAULT_TEXT_MAX) throw new ApiError(413, 'vault_full', 'This vault is full');
}

/** Refuses a new note once the vault holds `OB_VAULT_NOTES_MAX`. */
export function checkVaultNotes(db: Db, vaultId: string): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM ob_notes WHERE vault_id = ?').get(vaultId) as { n: number };
  if (n >= OB_VAULT_NOTES_MAX) throw new ApiError(413, 'vault_full', 'This vault is full');
}

/** The byte delta a body change makes, for `checkVaultText`. */
export const textDelta = (next: string, previous: string) => bytes(next) - bytes(previous);
