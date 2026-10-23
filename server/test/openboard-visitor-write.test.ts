import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OB_VISITOR_BODY_MAX, OB_VISITOR_VAULT_NOTES_MAX } from '../src/openboard/visitor.js';
import { type Account, call, fakeCipher, makeApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Account;
beforeEach(async () => {
  t = await makeApp();
  alice = await setupAdmin(t.app, 'alice');
});
afterEach(async () => {
  await t.close();
});

interface Note {
  id: string;
  vaultId: string;
  folderId: string | null;
  title: string;
  body: string;
  updatedAt: string;
  visitorEdited: boolean;
}
interface Payload {
  permission: string;
  folders: { id: string; vaultId: string; name: string }[];
  notes: Note[];
}

/** Publishes a vault with a folder "F" holding the given notes, plus a root Index note. */
async function publishVault(name: string, notes: { title: string; body: string }[] = [{ title: 'Alpha', body: 'alpha body' }]) {
  const res = await call(t.app, 'POST', '/api/openboard/publish', {
    cookie: alice.cookie,
    body: {
      kind: 'vault',
      vaultName: name,
      color: '#45A89E',
      destPath: [],
      rootName: name,
      folders: [{ key: 'f', parentKey: null, name: 'F' }],
      notes: [{ folderKey: null, title: 'Index', body: 'hub' }, ...notes.map((n) => ({ folderKey: 'f', ...n }))],
      overwrite: false,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().vaultId as string;
}

async function makeLink(vaultIds: string[], permission?: 'read' | 'write') {
  const res = await call(t.app, 'POST', '/api/openboard/links', {
    cookie: alice.cookie,
    body: { label: 'L', vaultIds, ...(permission ? { permission } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; token: string };
}

/** A visitor: no cookie, the CSRF header the visitor client sends. */
const visitor = (method: 'GET' | 'PATCH' | 'POST', url: string, body?: unknown, ip = '10.0.0.1') => call(t.app, method, url, { body, ip });
const payload = async (token: string, ip?: string): Promise<Payload> => (await visitor('GET', `/api/ob/${token}`, undefined, ip)).json();
const edit = (token: string, noteId: string, body: unknown, ip?: string) => visitor('PATCH', `/api/ob/${token}/notes/${noteId}`, body, ip);
const create = (token: string, body: unknown, ip?: string) => visitor('POST', `/api/ob/${token}/notes`, body, ip);
const preview = async (): Promise<Payload> => (await call(t.app, 'GET', '/api/openboard/preview', { cookie: alice.cookie })).json();
const noteBy = (p: Payload, title: string) => p.notes.find((n) => n.title === title)!;

describe('public payload', () => {
  it('carries the link permission and visitorEdited on every note', async () => {
    const v = await publishVault('V');
    const read = await makeLink([v]);
    const write = await makeLink([v], 'write');
    expect((await payload(read.token)).permission).toBe('read');
    const p = await payload(write.token);
    expect(p.permission).toBe('write');
    expect(p.notes.every((n) => n.visitorEdited === false)).toBe(true);
  });
});

describe('visitor edits', () => {
  it('a write link changes title and body, marks the note visitor-edited and bumps updatedAt', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const before = noteBy(await payload(link.token), 'Alpha');
    const res = await edit(link.token, before.id, { baseUpdatedAt: before.updatedAt, title: 'Alpha 2', body: 'new body' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: before.id, title: 'Alpha 2', body: 'new body', visitorEdited: true });
    expect(res.json().updatedAt > before.updatedAt).toBe(true);
    const owner = noteBy(await preview(), 'Alpha 2');
    expect(owner).toMatchObject({ body: 'new body', visitorEdited: true });
  });

  it('a body-only edit keeps the title', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const n = noteBy(await payload(link.token), 'Alpha');
    const res = await edit(link.token, n.id, { baseUpdatedAt: n.updatedAt, body: 'only body' });
    expect(res.json()).toMatchObject({ title: 'Alpha', body: 'only body' });
  });

  it('a stale baseUpdatedAt is 409 stale and changes nothing', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const n = noteBy(await payload(link.token), 'Alpha');
    expect((await edit(link.token, n.id, { baseUpdatedAt: n.updatedAt, body: 'first' })).statusCode).toBe(200);
    const res = await edit(link.token, n.id, { baseUpdatedAt: n.updatedAt, body: 'second' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('stale');
    expect(noteBy(await payload(link.token), 'Alpha').body).toBe('first');
  });

  it('a read link cannot edit or create: 403 read_only, nothing written', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v]);
    const p = await payload(link.token);
    const n = noteBy(p, 'Alpha');
    const e = await edit(link.token, n.id, { baseUpdatedAt: n.updatedAt, body: 'vandal' });
    expect(e.statusCode).toBe(403);
    expect(e.json().error).toBe('read_only');
    const c = await create(link.token, { vaultId: v, folderId: null, title: 'New', body: 'x' });
    expect(c.statusCode).toBe(403);
    const after = await preview();
    expect(noteBy(after, 'Alpha').body).toBe('alpha body');
    expect(after.notes.some((x) => x.title === 'New')).toBe(false);
  });

  it('downgrading the link to read stops the next write at once', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const n = noteBy(await payload(link.token), 'Alpha');
    const patch = await call(t.app, 'PATCH', `/api/openboard/links/${link.id}`, { cookie: alice.cookie, body: { permission: 'read' } });
    expect(patch.statusCode).toBe(200);
    expect((await edit(link.token, n.id, { baseUpdatedAt: n.updatedAt, body: 'late' })).statusCode).toBe(403);
  });

  it('a deleted link is 404 on writes', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const n = noteBy(await payload(link.token), 'Alpha');
    await call(t.app, 'DELETE', `/api/openboard/links/${link.id}`, { cookie: alice.cookie });
    expect((await edit(link.token, n.id, { baseUpdatedAt: n.updatedAt, body: 'x' })).statusCode).toBe(404);
  });

  it('a note in a vault the link does not grant, or an unknown note, is 404', async () => {
    const v = await publishVault('V');
    const other = await publishVault('Other', [{ title: 'Secret', body: 'secret body' }]);
    const link = await makeLink([v], 'write');
    const secret = noteBy(await preview(), 'Secret');
    expect(secret.vaultId).toBe(other);
    expect((await edit(link.token, secret.id, { baseUpdatedAt: secret.updatedAt, body: 'pwned' })).statusCode).toBe(404);
    expect((await edit(link.token, randomUUID(), { baseUpdatedAt: secret.updatedAt, body: 'x' })).statusCode).toBe(404);
    expect(noteBy(await preview(), 'Secret').body).toBe('secret body');
  });

  it('keeps Index notes in their role: no rename to or from Index; body edits are fine', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const p = await payload(link.token);
    const ix = noteBy(p, 'Index');
    const a = noteBy(p, 'Alpha');
    expect((await edit(link.token, a.id, { baseUpdatedAt: a.updatedAt, title: 'Index' })).statusCode).toBe(400);
    expect((await edit(link.token, ix.id, { baseUpdatedAt: ix.updatedAt, title: 'Hub' })).statusCode).toBe(400);
    const ok = await edit(link.token, ix.id, { baseUpdatedAt: ix.updatedAt, title: 'Index', body: 'new hub text' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().body).toBe('new hub text');
  });

  it('validates the title and body size', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const n = noteBy(await payload(link.token), 'Alpha');
    const base = { baseUpdatedAt: n.updatedAt };
    expect((await edit(link.token, n.id, { ...base, title: 'two\nlines' })).statusCode).toBe(400);
    expect((await edit(link.token, n.id, { ...base, title: '   ' })).statusCode).toBe(400);
    expect((await edit(link.token, n.id, { ...base, title: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await edit(link.token, n.id, { ...base, title: 'x'.repeat(200) })).statusCode).toBe(200);
    const fresh = noteBy(await payload(link.token), 'x'.repeat(200));
    expect((await edit(link.token, n.id, { baseUpdatedAt: fresh.updatedAt, body: 'b'.repeat(OB_VISITOR_BODY_MAX + 1) })).statusCode).toBe(413);
    expect((await edit(link.token, n.id, { baseUpdatedAt: fresh.updatedAt, body: 'b'.repeat(OB_VISITOR_BODY_MAX) })).statusCode).toBe(200);
  });

  it('requires baseUpdatedAt and the CSRF header', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const n = noteBy(await payload(link.token), 'Alpha');
    expect((await edit(link.token, n.id, { body: 'x' })).statusCode).toBe(400);
    const noHeader = await t.app.inject({
      method: 'PATCH',
      url: `/api/ob/${link.token}/notes/${n.id}`,
      payload: { baseUpdatedAt: n.updatedAt, body: 'x' },
      remoteAddress: '10.0.0.1',
    });
    expect(noHeader.statusCode).toBe(403);
  });
});

describe('visitor creates', () => {
  it('creates a note at the vault root and in a folder', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const folder = (await payload(link.token)).folders[0];
    const root = await create(link.token, { vaultId: v, folderId: null, title: 'Root note', body: 'r' });
    expect(root.statusCode).toBe(201);
    expect(root.json()).toMatchObject({ vaultId: v, folderId: null, title: 'Root note', body: 'r', visitorEdited: true });
    const inFolder = await create(link.token, { vaultId: v, folderId: folder.id, title: 'Folder note', body: '' });
    expect(inFolder.statusCode).toBe(201);
    const p = await payload(link.token);
    expect(noteBy(p, 'Folder note').folderId).toBe(folder.id);
    expect(noteBy(p, 'Root note').id).toBe(root.json().id);
  });

  it('refuses a folder of another vault, an ungranted vault and an Index title', async () => {
    const v = await publishVault('V');
    const w = await publishVault('W');
    const link = await makeLink([v, w], 'write');
    const lone = await makeLink([v], 'write');
    const wFolder = (await payload(link.token)).folders.find((f) => f.vaultId === w)!;
    expect((await create(link.token, { vaultId: v, folderId: wFolder.id, title: 'X', body: '' })).statusCode).toBe(400);
    expect((await create(lone.token, { vaultId: w, folderId: null, title: 'X', body: '' })).statusCode).toBe(404);
    expect((await create(link.token, { vaultId: v, folderId: null, title: 'Index', body: '' })).statusCode).toBe(400);
  });

  it('refuses a new note once the vault holds the maximum number of notes', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const db = new DatabaseSync(path.join(t.dataDir, 'inked.db'));
    try {
      const have = (db.prepare('SELECT COUNT(*) AS n FROM ob_notes WHERE vault_id = ?').get(v) as { n: number }).n;
      const ins = db.prepare(
        "INSERT INTO ob_notes (id, vault_id, folder_id, title, body, created_at, updated_at) VALUES (?, ?, NULL, 'filler', '', 't', 't')",
      );
      db.exec('BEGIN');
      for (let i = have; i < OB_VISITOR_VAULT_NOTES_MAX; i++) ins.run(randomUUID(), v);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const res = await create(link.token, { vaultId: v, folderId: null, title: 'One too many', body: '' });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('vault_full');
  });
});

describe('write rate limit', () => {
  it('locks an IP after 30 writes a minute; reads and other IPs carry on', async () => {
    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    for (let i = 0; i < 30; i++) {
      expect((await create(link.token, { vaultId: v, folderId: null, title: `N${i}`, body: '' }, '10.0.0.7')).statusCode).toBe(201);
    }
    const locked = await create(link.token, { vaultId: v, folderId: null, title: 'N30', body: '' }, '10.0.0.7');
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await visitor('GET', `/api/ob/${link.token}`, undefined, '10.0.0.7')).statusCode).toBe(200);
    expect((await create(link.token, { vaultId: v, folderId: null, title: 'Other', body: '' }, '10.0.0.8')).statusCode).toBe(201);
  });
});

describe('private data', () => {
  it('visitor writes never change the private encrypted tables', async () => {
    const vaultId = randomUUID();
    const as = { cookie: alice.cookie };
    expect((await call(t.app, 'POST', '/api/vaults', { ...as, body: { id: vaultId, encMeta: fakeCipher(), wrappedKey: fakeCipher(60) } })).statusCode).toBe(200);
    const noteRes = await call(t.app, 'POST', `/api/vaults/${vaultId}/notes`, {
      ...as,
      body: { id: randomUUID(), folderId: null, encMeta: fakeCipher(), encBody: fakeCipher(500) },
    });
    expect(noteRes.statusCode).toBe(200);

    const snapshot = () => {
      const db = new DatabaseSync(path.join(t.dataDir, 'inked.db'));
      try {
        return ['vaults', 'folders', 'notes', 'images'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
      } finally {
        db.close();
      }
    };
    const before = JSON.stringify(snapshot());

    const v = await publishVault('V');
    const link = await makeLink([v], 'write');
    const n = noteBy(await payload(link.token), 'Alpha');
    expect((await edit(link.token, n.id, { baseUpdatedAt: n.updatedAt, title: 'Changed', body: 'changed' })).statusCode).toBe(200);
    expect((await create(link.token, { vaultId: v, folderId: null, title: 'Added', body: 'added' })).statusCode).toBe(201);

    expect(JSON.stringify(snapshot())).toBe(before);
  });
});
