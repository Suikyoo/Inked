import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OB_VAULT_NOTES_MAX } from '../src/openboard/write.js';
import { type Account, call, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

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

const COLOR = '#45A89E';

const newVault = (who: Account, body: unknown) => call(t.app, 'POST', '/api/openboard/vaults', { cookie: who.cookie, body });
const patchVault = (who: Account, id: string, body: unknown) =>
  call(t.app, 'PATCH', `/api/openboard/vaults/${id}`, { cookie: who.cookie, body });
const newFolder = (who: Account, body: unknown) => call(t.app, 'POST', '/api/openboard/folders', { cookie: who.cookie, body });
const newNote = (who: Account, body: unknown) => call(t.app, 'POST', '/api/openboard/notes', { cookie: who.cookie, body });
const preview = async (who: Account) => {
  const res = await call(t.app, 'GET', '/api/openboard/preview', { cookie: who.cookie });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    vaults: { id: string; name: string; origin: string }[];
    folders: { id: string; vaultId: string; parentId: string | null; name: string }[];
    notes: { id: string; vaultId: string; folderId: string | null; title: string; body: string }[];
  };
};

/** A published vault, for the "published vaults refuse creates" cases. */
async function publishVault(name = 'Docs') {
  const res = await call(t.app, 'POST', '/api/openboard/publish', {
    cookie: alice.cookie,
    body: {
      kind: 'vault',
      vaultName: name,
      color: COLOR,
      destPath: [],
      rootName: name,
      folders: [],
      notes: [{ folderKey: null, title: 'Index', body: 'hub' }],
      overwrite: false,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().vaultId as string;
}

describe('openboard-native vaults', () => {
  it('creates a native vault that shows up in the listing', async () => {
    const res = await newVault(alice, { name: 'Scratch', color: COLOR });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Scratch', color: COLOR, origin: 'native' });

    const content = await call(t.app, 'GET', '/api/openboard/content', { cookie: alice.cookie });
    expect(content.json().vaults).toHaveLength(1);
    expect(content.json().vaults[0].origin).toBe('native');
  });

  it('refuses a name a published vault already holds', async () => {
    await publishVault('Docs');
    const res = await newVault(alice, { name: 'Docs', color: COLOR });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('name_taken');
  });

  it('refuses a second native vault of the same name', async () => {
    expect((await newVault(alice, { name: 'Scratch', color: COLOR })).statusCode).toBe(201);
    const res = await newVault(alice, { name: 'Scratch', color: COLOR });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('name_taken');
  });

  it('lets another user hold a native vault of the same name', async () => {
    expect((await newVault(alice, { name: 'Scratch', color: COLOR })).statusCode).toBe(201);
    expect((await newVault(bob, { name: 'Scratch', color: COLOR })).statusCode).toBe(201);
  });

  it('renames and recolours a native vault', async () => {
    const id = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    const res = await patchVault(alice, id, { name: 'Notes', color: '#D19C3C' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Notes', color: '#D19C3C', origin: 'native' });
  });

  it('refuses a rename onto another vault name', async () => {
    const id = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    await publishVault('Docs');
    expect((await patchVault(alice, id, { name: 'Docs' })).statusCode).toBe(409);
  });

  it('refuses a rename of a published vault', async () => {
    const id = await publishVault('Docs');
    const res = await patchVault(alice, id, { name: 'Renamed' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_native');
  });

  it('creates a folder and a note in a native vault', async () => {
    const vaultId = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    const folder = await newFolder(alice, { vaultId, parentId: null, name: 'Ideas' });
    expect(folder.statusCode).toBe(201);
    const folderId = folder.json().id as string;

    const note = await newNote(alice, { vaultId, folderId, title: 'First', body: 'written here' });
    expect(note.statusCode).toBe(201);

    const p = await preview(alice);
    expect(p.folders).toEqual([{ id: folderId, vaultId, parentId: null, name: 'Ideas' }]);
    expect(p.notes.map((n) => [n.title, n.body, n.folderId])).toEqual([['First', 'written here', folderId]]);
  });

  it('nests a folder under another', async () => {
    const vaultId = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    const parentId = (await newFolder(alice, { vaultId, parentId: null, name: 'Top' })).json().id as string;
    const child = await newFolder(alice, { vaultId, parentId, name: 'Under' });
    expect(child.statusCode).toBe(201);
    expect(child.json().parentId).toBe(parentId);
  });

  it('refuses a folder whose parent is in another vault', async () => {
    const a = (await newVault(alice, { name: 'A', color: COLOR })).json().id as string;
    const b = (await newVault(alice, { name: 'B', color: COLOR })).json().id as string;
    const parentId = (await newFolder(alice, { vaultId: a, parentId: null, name: 'Top' })).json().id as string;
    expect((await newFolder(alice, { vaultId: b, parentId, name: 'Bad' })).statusCode).toBe(400);
  });

  it('refuses a folder or a note in a published vault', async () => {
    const vaultId = await publishVault('Docs');
    expect((await newFolder(alice, { vaultId, parentId: null, name: 'Ideas' })).json().error).toBe('not_native');
    expect((await newNote(alice, { vaultId, folderId: null, title: 'Nope', body: '' })).json().error).toBe('not_native');
  });

  it('keeps Index reserved for folder pages', async () => {
    const vaultId = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    expect((await newNote(alice, { vaultId, folderId: null, title: 'Index', body: '' })).statusCode).toBe(400);
  });

  it('serves a native vault, and a folder with no Index note, through a read link', async () => {
    const vaultId = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    const folderId = (await newFolder(alice, { vaultId, parentId: null, name: 'Ideas' })).json().id as string;
    expect((await newNote(alice, { vaultId, folderId, title: 'First', body: 'see [[Second]]' })).statusCode).toBe(201);
    expect((await newNote(alice, { vaultId, folderId, title: 'Second', body: 'here' })).statusCode).toBe(201);

    const link = await call(t.app, 'POST', '/api/openboard/links', {
      cookie: alice.cookie,
      body: { label: 'R', vaultIds: [vaultId], permission: 'read' },
    });
    expect(link.statusCode).toBe(201);

    const seen = await call(t.app, 'GET', `/api/ob/${link.json().token}`);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().vaults.map((v: { name: string }) => v.name)).toEqual(['Scratch']);
    expect(seen.json().folders.map((f: { name: string }) => f.name)).toEqual(['Ideas']);
    expect(seen.json().notes.map((n: { title: string }) => n.title).sort()).toEqual(['First', 'Second']);
  });

  it('lets a visitor edit a native note through a write link, flagged as a visitor edit', async () => {
    const vaultId = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    const note = await newNote(alice, { vaultId, folderId: null, title: 'First', body: 'mine' });
    expect(note.statusCode).toBe(201);

    const link = await call(t.app, 'POST', '/api/openboard/links', {
      cookie: alice.cookie,
      body: { label: 'W', vaultIds: [vaultId], permission: 'write' },
    });
    const res = await call(t.app, 'PATCH', `/api/ob/${link.json().token}/notes/${note.json().id}`, {
      headers: { 'X-Inked': '1' },
      body: { baseUpdatedAt: note.json().updatedAt, body: 'theirs' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'theirs', visitorEdited: true, ownerEdited: false });
  });

  it("404s on another user's vault for every create route", async () => {
    const vaultId = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    expect((await patchVault(bob, vaultId, { name: 'Theirs' })).statusCode).toBe(404);
    expect((await newFolder(bob, { vaultId, parentId: null, name: 'Theirs' })).statusCode).toBe(404);
    expect((await newNote(bob, { vaultId, folderId: null, title: 'Theirs', body: '' })).statusCode).toBe(404);
  });

  it('needs a session', async () => {
    expect((await call(t.app, 'POST', '/api/openboard/vaults', { body: { name: 'X', color: COLOR } })).statusCode).toBe(401);
  });

  it('rejects a malformed vault', async () => {
    expect((await newVault(alice, { name: '', color: COLOR })).statusCode).toBe(400);
    expect((await newVault(alice, { name: 'X', color: 'red' })).statusCode).toBe(400);
    expect((await newVault(alice, { name: 'X' })).statusCode).toBe(400);
  });

  it('refuses a note past the vault note cap', async () => {
    const vaultId = (await newVault(alice, { name: 'Scratch', color: COLOR })).json().id as string;
    // One statement, not 5000 round trips: a slow loop here starves the other test workers.
    t.app.db
      .prepare(
        `INSERT INTO ob_notes (id, vault_id, folder_id, title, body, created_at, updated_at)
         WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ?)
         SELECT 'n' || i, ?, NULL, 'T' || i, '', ?, ? FROM c`,
      )
      .run(OB_VAULT_NOTES_MAX, vaultId, new Date().toISOString(), new Date().toISOString());
    const res = await newNote(alice, { vaultId, folderId: null, title: 'One too many', body: '' });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('vault_full');
  });
});
