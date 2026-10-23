import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';

// The openboard tables as the 2026-10-22 release created them, before link permissions and visitor edits.
const OLD_OPENBOARD = `
CREATE TABLE users (id TEXT PRIMARY KEY);
CREATE TABLE ob_vaults (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ob_notes (id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES ob_vaults(id) ON DELETE CASCADE,
  folder_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE ob_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, token TEXT NOT NULL UNIQUE, views INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
INSERT INTO users (id) VALUES ('u1');
INSERT INTO ob_vaults VALUES ('v1', 'u1', 'V', '#000000', 't', 't');
INSERT INTO ob_notes VALUES ('n1', 'v1', NULL, 'N', 'body', 't', 't');
INSERT INTO ob_links VALUES ('l1', 'u1', 'Old link', 'tok', 4, 't');
`;

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'inked-migrate-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('openDb migrations', () => {
  it('adds the link permission and visitor-edit columns to an existing database, idempotently', () => {
    const file = path.join(dir, 'inked.db');
    const old = new DatabaseSync(file);
    old.exec(OLD_OPENBOARD);
    old.close();

    openDb(file).close();
    const db = openDb(file);
    try {
      expect(columns(db, 'ob_links')).toContain('permission');
      expect(columns(db, 'ob_notes')).toContain('visitor_edited_at');
      expect(db.prepare('SELECT published_title FROM ob_notes WHERE id = ?').get('n1')).toEqual({ published_title: 'N' });
      expect(db.prepare('SELECT permission FROM ob_links WHERE id = ?').get('l1')).toEqual({ permission: 'read' });
      expect(db.prepare('SELECT visitor_edited_at FROM ob_notes WHERE id = ?').get('n1')).toEqual({ visitor_edited_at: null });
      expect(() => db.prepare("UPDATE ob_links SET permission = 'admin' WHERE id = 'l1'").run()).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it('creates both columns on a fresh database', () => {
    const db = openDb(path.join(dir, 'fresh.db'));
    try {
      expect(columns(db, 'ob_links')).toContain('permission');
      expect(columns(db, 'ob_notes')).toContain('visitor_edited_at');
    } finally {
      db.close();
    }
  });
});
