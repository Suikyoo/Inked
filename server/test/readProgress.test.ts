import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, call, fakeCipher, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Account;
let bob: Account;
beforeEach(async () => {
  t = await makeApp();
  alice = await setupAdmin(t.app, 'alice');
  bob = await inviteUser(t.app, alice, 'bob');
});
afterEach(async () => {
  await t.close();
});

const as = (who: Account) => ({
  get: (url: string) => call(t.app, 'GET', url, { cookie: who.cookie }),
  post: (url: string, body: unknown) => call(t.app, 'POST', url, { cookie: who.cookie, body }),
  put: (url: string, body: unknown) => call(t.app, 'PUT', url, { cookie: who.cookie, body }),
  del: (url: string) => call(t.app, 'DELETE', url, { cookie: who.cookie }),
});

async function createVault(who: Account) {
  const res = await as(who).post('/api/vaults', { id: randomUUID(), encMeta: fakeCipher(), wrappedKey: fakeCipher(60) });
  expect(res.statusCode).toBe(200);
  return res.json().vault;
}

async function createNote(who: Account, vaultId: string, bodyBytes = 500) {
  const res = await as(who).post(`/api/vaults/${vaultId}/notes`, {
    id: randomUUID(),
    folderId: null,
    encMeta: fakeCipher(),
    encBody: fakeCipher(bodyBytes),
  });
  expect(res.statusCode).toBe(200);
  return res.json().note;
}

const mark = (who: Account, items: unknown[]) => as(who).post('/api/read-progress', { items });
const treeNote = async (who: Account, vaultId: string, noteId: string) =>
  (await as(who).get(`/api/vaults/${vaultId}/tree`)).json().notes.find((n: { id: string }) => n.id === noteId);
const rowCount = (noteId: string) => {
  const db = new DatabaseSync(path.join(t.dataDir, 'inked.db'));
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM read_progress WHERE note_id = ?').get(noteId) as { c: number }).c;
  } finally {
    db.close();
  }
};

describe('read progress', () => {
  it('tree returns read: null for unread notes', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    expect((await treeNote(alice, vault.id, note.id)).read).toBeNull();
  });

  it('stores a checkpoint and returns it in the tree', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    const res = await mark(alice, [{ noteId: note.id, pct: 50, size: note.size }]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await treeNote(alice, vault.id, note.id)).read).toEqual({ pct: 50, size: note.size });
  });

  it('same size keeps the higher checkpoint', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    await mark(alice, [{ noteId: note.id, pct: 100, size: note.size }]);
    await mark(alice, [{ noteId: note.id, pct: 25, size: note.size }]);
    expect((await treeNote(alice, vault.id, note.id)).read).toEqual({ pct: 100, size: note.size });
  });

  it('stale write for an older smaller version does not lower progress', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id, 500);
    const s1 = note.size;
    await mark(alice, [{ noteId: note.id, pct: 100, size: s1 }]);
    const put = await as(alice).put(`/api/notes/${note.id}`, { encBody: fakeCipher(2000), baseUpdatedAt: note.updatedAt });
    expect(put.statusCode).toBe(200);
    const s2 = put.json().note.size;
    expect(s2).toBeGreaterThan(s1);
    await mark(alice, [{ noteId: note.id, pct: 100, size: s2 }]);
    await mark(alice, [{ noteId: note.id, pct: 100, size: s1 }]);
    expect((await treeNote(alice, vault.id, note.id)).read).toEqual({ pct: 100, size: s2 });
  });

  it('skips notes of another user and unknown ids without failing the batch', async () => {
    const aVault = await createVault(alice);
    const bVault = await createVault(bob);
    const aNote = await createNote(alice, aVault.id);
    const bNote = await createNote(bob, bVault.id);
    const res = await mark(alice, [
      { noteId: bNote.id, pct: 75, size: bNote.size },
      { noteId: randomUUID(), pct: 75, size: 10 },
      { noteId: aNote.id, pct: 25, size: aNote.size },
    ]);
    expect(res.statusCode).toBe(200);
    expect(rowCount(bNote.id)).toBe(0);
    expect(rowCount(aNote.id)).toBe(1);
    expect((await treeNote(bob, bVault.id, bNote.id)).read).toBeNull();
    expect((await treeNote(alice, aVault.id, aNote.id)).read).toEqual({ pct: 25, size: aNote.size });
  });

  it('progress is per user', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    await mark(alice, [{ noteId: note.id, pct: 100, size: note.size }]);
    expect((await mark(bob, [{ noteId: note.id, pct: 100, size: note.size }])).statusCode).toBe(200);
    expect(rowCount(note.id)).toBe(1);
  });

  it('rejects pct 0 or 30, negative size, 0 or 201 items', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    const ok = { noteId: note.id, pct: 50, size: 10 };
    expect((await mark(alice, [{ ...ok, pct: 0 }])).statusCode).toBe(400);
    expect((await mark(alice, [{ ...ok, pct: 30 }])).statusCode).toBe(400);
    expect((await mark(alice, [{ ...ok, size: -1 }])).statusCode).toBe(400);
    expect((await mark(alice, [{ ...ok, noteId: 'nope' }])).statusCode).toBe(400);
    expect((await mark(alice, [])).statusCode).toBe(400);
    expect((await mark(alice, Array.from({ length: 201 }, () => ok))).statusCode).toBe(400);
    expect((await mark(alice, Array.from({ length: 200 }, () => ok))).statusCode).toBe(200);
  });

  it('requires a session', async () => {
    const res = await call(t.app, 'POST', '/api/read-progress', { body: { items: [{ noteId: randomUUID(), pct: 50, size: 1 }] } });
    expect(res.statusCode).toBe(401);
  });

  it('requires X-Inked header', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/read-progress',
      headers: { cookie: `inked_session=${alice.cookie}` },
      payload: { items: [{ noteId: randomUUID(), pct: 50, size: 1 }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('deleting the note removes its progress', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    await mark(alice, [{ noteId: note.id, pct: 50, size: note.size }]);
    expect(rowCount(note.id)).toBe(1);
    expect((await as(alice).del(`/api/notes/${note.id}`)).statusCode).toBe(200);
    expect(rowCount(note.id)).toBe(0);
    expect((await as(alice).get(`/api/vaults/${vault.id}/tree`)).json().notes).toEqual([]);
  });
});
