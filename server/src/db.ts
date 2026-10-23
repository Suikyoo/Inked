import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                        TEXT PRIMARY KEY,
  username                  TEXT NOT NULL UNIQUE,
  is_admin                  INTEGER NOT NULL DEFAULT 0,
  kdf_salt                  TEXT NOT NULL,
  kdf_params                TEXT NOT NULL,
  auth_salt                 TEXT NOT NULL,
  auth_hash                 TEXT NOT NULL,
  wrapped_user_key          TEXT NOT NULL,
  recovery_salt             TEXT NOT NULL,
  recovery_hash             TEXT NOT NULL,
  wrapped_user_key_recovery TEXT NOT NULL,
  created_at                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS vaults (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enc_meta    TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vaults_user ON vaults(user_id);

-- Deleting a folder cascades to its subfolders and their notes.
CREATE TABLE IF NOT EXISTS folders (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  enc_meta   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS folders_vault ON folders(vault_id);
CREATE INDEX IF NOT EXISTS folders_parent ON folders(parent_id);

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  folder_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  enc_meta   TEXT NOT NULL,
  enc_body   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_vault ON notes(vault_id, updated_at);
CREATE INDEX IF NOT EXISTS notes_folder ON notes(folder_id);

CREATE TABLE IF NOT EXISTS note_vectors (
  note_id           TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  vault_id          TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  enc_vec           TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_vectors_vault ON note_vectors(vault_id);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enc_settings TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  size       INTEGER NOT NULL,
  enc_blob   BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS images_vault ON images(vault_id);

-- Openboard: plaintext content the owner deliberately published, shared through secret links.
-- Separate from (and never referencing) the private encrypted tables above.
CREATE TABLE IF NOT EXISTS ob_vaults (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ob_vaults_user ON ob_vaults(user_id, name);

CREATE TABLE IF NOT EXISTS ob_folders (
  id        TEXT PRIMARY KEY,
  vault_id  TEXT NOT NULL REFERENCES ob_vaults(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES ob_folders(id) ON DELETE CASCADE,
  name      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ob_folders_vault ON ob_folders(vault_id);
CREATE INDEX IF NOT EXISTS ob_folders_parent ON ob_folders(parent_id);

CREATE TABLE IF NOT EXISTS ob_notes (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT NOT NULL REFERENCES ob_vaults(id) ON DELETE CASCADE,
  folder_id  TEXT REFERENCES ob_folders(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  visitor_edited_at TEXT,      -- set when a visitor changed or added the note through a write link
  published_title TEXT         -- the title the owner published it under; null for a note a visitor added
);
CREATE INDEX IF NOT EXISTS ob_notes_vault ON ob_notes(vault_id);
CREATE INDEX IF NOT EXISTS ob_notes_folder ON ob_notes(folder_id);

CREATE TABLE IF NOT EXISTS ob_images (
  vault_id   TEXT NOT NULL REFERENCES ob_vaults(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, id)
);

CREATE TABLE IF NOT EXISTS ob_links (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  views      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write'))
);
CREATE INDEX IF NOT EXISTS ob_links_user ON ob_links(user_id);

CREATE TABLE IF NOT EXISTS ob_link_vaults (
  link_id     TEXT NOT NULL REFERENCES ob_links(id) ON DELETE CASCADE,
  ob_vault_id TEXT NOT NULL REFERENCES ob_vaults(id) ON DELETE CASCADE,
  PRIMARY KEY (link_id, ob_vault_id)
);
CREATE INDEX IF NOT EXISTS ob_link_vaults_vault ON ob_link_vaults(ob_vault_id);

-- Read progress: per user and note, the furthest checkpoint reached. Only ids, sizes and timestamps.
CREATE TABLE IF NOT EXISTS read_progress (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  pct        INTEGER NOT NULL,   -- 25, 50, 75 or 100
  read_size  INTEGER NOT NULL,   -- notes.size of the version the checkpoint was reached on
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, note_id)
);
CREATE INDEX IF NOT EXISTS read_progress_note ON read_progress(note_id);
`;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  db.exec('PRAGMA user_version = 1');
  return db;
}

/**
 * Columns added after a table first shipped. SCHEMA has them for new databases; CREATE TABLE IF NOT EXISTS
 * skips existing tables, so each one is added here when missing. Idempotent.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string; backfill?: string }[] = [
  { table: 'ob_links', column: 'permission', definition: "TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read', 'write'))" },
  { table: 'ob_notes', column: 'visitor_edited_at', definition: 'TEXT' },
  {
    table: 'ob_notes',
    column: 'published_title',
    definition: 'TEXT',
    backfill: 'UPDATE ob_notes SET published_title = title WHERE visitor_edited_at IS NULL',
  },
];

function migrate(db: Db): void {
  for (const { table, column, definition, backfill } of ADDED_COLUMNS) {
    const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
    if (has) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (backfill) db.exec(backfill);
  }
}

/** Runs fn inside a write transaction; rolls back if it throws. fn must be synchronous. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = (): string => new Date().toISOString();

/**
 * Next updated_at for a row: never equal to or before the previous value, so
 * optimistic-concurrency checks still work for two writes in the same millisecond.
 */
export function bumpTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

// Row shapes as stored.
export interface UserRow {
  id: string;
  username: string;
  is_admin: number;
  kdf_salt: string;
  kdf_params: string;
  auth_salt: string;
  auth_hash: string;
  wrapped_user_key: string;
  recovery_salt: string;
  recovery_hash: string;
  wrapped_user_key_recovery: string;
  created_at: string;
}

export interface VaultRow {
  id: string;
  user_id: string;
  enc_meta: string;
  wrapped_key: string;
  created_at: string;
  updated_at: string;
}

export interface FolderRow {
  id: string;
  vault_id: string;
  parent_id: string | null;
  enc_meta: string;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: string;
  vault_id: string;
  folder_id: string | null;
  enc_meta: string;
  enc_body: string;
  size: number;
  created_at: string;
  updated_at: string;
}

export interface ReadProgressRow {
  user_id: string;
  note_id: string;
  pct: number;
  read_size: number;
  updated_at: string;
}

export interface NoteVectorRow {
  note_id: string;
  vault_id: string;
  model: string;
  enc_vec: string;
  source_updated_at: string;
  updated_at: string;
}

export interface ObVaultRow {
  id: string;
  user_id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface ObFolderRow {
  id: string;
  vault_id: string;
  parent_id: string | null;
  name: string;
}

export interface ObNoteRow {
  id: string;
  vault_id: string;
  folder_id: string | null;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  visitor_edited_at: string | null;
  published_title: string | null;
}

export interface UserSettingsRow {
  user_id: string;
  enc_settings: string;
  updated_at: string;
}
