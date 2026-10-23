import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publish as storePublish } from '../src/openboard/store.js';
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

type Kind = 'vault' | 'folder' | 'note';
interface Req {
  kind: Kind;
  vaultName: string;
  color: string;
  destPath: string[];
  rootName: string;
  folders: { key: string; parentKey: string | null; name: string }[];
  notes: { folderKey: string | null; title: string; body: string }[];
  overwrite: boolean;
}

const COLOR = '#45A89E';

const vaultReq = (name: string, over: Partial<Req> = {}): Req => ({
  kind: 'vault',
  vaultName: name,
  color: COLOR,
  destPath: [],
  rootName: name,
  folders: [{ key: 'f1', parentKey: null, name: 'Topics' }],
  notes: [
    { folderKey: null, title: 'Index', body: '# Hello' },
    { folderKey: 'f1', title: 'First', body: 'first body' },
  ],
  overwrite: false,
  ...over,
});

const folderReq = (vaultName: string, destPath: string[], name: string, notes: Req['notes'], over: Partial<Req> = {}): Req => ({
  kind: 'folder',
  vaultName,
  color: COLOR,
  destPath,
  rootName: name,
  folders: [],
  notes,
  overwrite: false,
  ...over,
});

const noteReq = (vaultName: string, destPath: string[], title: string, body: string, over: Partial<Req> = {}): Req => ({
  kind: 'note',
  vaultName,
  color: COLOR,
  destPath,
  rootName: title,
  folders: [],
  notes: [{ folderKey: null, title, body }],
  overwrite: false,
  ...over,
});

const publish = (who: Account, body: unknown) => call(t.app, 'POST', '/api/openboard/publish', { cookie: who.cookie, body });
const content = async (who: Account) => {
  const res = await call(t.app, 'GET', '/api/openboard/content', { cookie: who.cookie });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    vaults: { id: string; name: string; color: string; updatedAt: string }[];
    folders: { id: string; vaultId: string; parentId: string | null; name: string }[];
    notes: { id: string; vaultId: string; folderId: string | null; title: string; body: string; createdAt: string; updatedAt: string }[];
  };
};
const bodies = (vaultId: string) =>
  (t.app.db.prepare('SELECT title, body FROM ob_notes WHERE vault_id = ? ORDER BY title').all(vaultId) as { title: string; body: string }[]).map(
    (r) => `${r.title}:${r.body}`,
  );

describe('openboard publish', () => {
  it('publishes a vault and lists it', async () => {
    const res = await publish(alice, vaultReq('Research'));
    expect(res.statusCode).toBe(201);
    const { vaultId, imageRefs } = res.json();
    expect(typeof vaultId).toBe('string');
    expect(imageRefs).toEqual([]);

    const c = await content(alice);
    expect(c.vaults).toHaveLength(1);
    expect(c.vaults[0]).toMatchObject({ id: vaultId, name: 'Research', color: COLOR });
    expect(c.folders).toEqual([{ id: expect.any(String), vaultId, parentId: null, name: 'Topics' }]);
    expect(c.notes).toHaveLength(2);
    for (const n of c.notes) expect(n.body).toBe('');
    const first = c.notes.find((n) => n.title === 'First')!;
    expect(first.folderId).toBe(c.folders[0].id);
    expect(c.notes.find((n) => n.title === 'Index')!.folderId).toBeNull();
  });

  it('publish requires login', async () => {
    const res = await call(t.app, 'POST', '/api/openboard/publish', { body: vaultReq('Research') });
    expect(res.statusCode).toBe(401);
    expect((await call(t.app, 'GET', '/api/openboard/content')).statusCode).toBe(401);
  });

  it('rejects malformed requests', async () => {
    expect((await publish(alice, { ...vaultReq('X'), kind: 'bogus' })).statusCode).toBe(400);
    expect((await publish(alice, { ...vaultReq('X'), color: 'red' })).statusCode).toBe(400);
    expect((await publish(alice, { ...vaultReq('X'), vaultName: '' })).statusCode).toBe(400);
    expect((await publish(alice, { ...vaultReq('X'), overwrite: 'yes' })).statusCode).toBe(400);
    expect((await publish(alice, { ...vaultReq('X'), rootName: 'Y' })).statusCode).toBe(400);
    expect((await publish(alice, noteReq('X', [], 'A', 'b', { rootName: 'B' }))).statusCode).toBe(400);
    // A note pointing at a folder key that is not in the request.
    const dangling = vaultReq('X', { notes: [{ folderKey: 'nope', title: 'A', body: '' }] });
    expect((await publish(alice, dangling)).statusCode).toBe(400);
    // Folder parents that form a cycle.
    const cycle = vaultReq('X', {
      folders: [
        { key: 'a', parentKey: 'b', name: 'A' },
        { key: 'b', parentKey: 'a', name: 'B' },
      ],
      notes: [],
    });
    expect((await publish(alice, cycle)).statusCode).toBe(400);
    expect((await content(alice)).vaults).toEqual([]);
  });

  it('conflict without overwrite', async () => {
    expect((await publish(alice, vaultReq('Research'))).statusCode).toBe(201);
    const before = await content(alice);

    const res = await publish(alice, vaultReq('Research', { notes: [{ folderKey: null, title: 'Other', body: 'x' }] }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'conflict',
      target: { kind: 'vault', name: 'Research', path: [] },
      removes: { folders: 1, notes: 2 },
      visitorEdits: 0,
    });
    expect(await content(alice)).toEqual(before);
  });

  it('vault overwrite keeps the vault id', async () => {
    const first = (await publish(alice, vaultReq('Research'))).json();
    t.app.db.prepare("UPDATE ob_vaults SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(first.vaultId);
    const res = await publish(
      alice,
      vaultReq('Research', { color: '#D19C3C', folders: [], notes: [{ folderKey: null, title: 'New', body: 'new body' }], overwrite: true }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().vaultId).toBe(first.vaultId);

    const c = await content(alice);
    expect(c.vaults).toHaveLength(1);
    expect(c.vaults[0]).toMatchObject({ id: first.vaultId, color: '#D19C3C' });
    expect(c.vaults[0].updatedAt > '2000-01-01T00:00:00.000Z').toBe(true);
    expect(c.folders).toEqual([]);
    expect(c.notes.map((n) => n.title)).toEqual(['New']);
    expect(bodies(first.vaultId)).toEqual(['New:new body']);
  });

  it('folder overwrite removes extras', async () => {
    const { vaultId } = (await publish(alice, vaultReq('V', { folders: [], notes: [] }))).json();
    const n = (title: string) => ({ folderKey: null, title, body: `${title} body` });
    expect((await publish(alice, folderReq('V', [], 'A', [n('one'), n('two')]))).statusCode).toBe(201);
    expect((await publish(alice, folderReq('V', [], 'B', [n('sib')]))).statusCode).toBe(201);

    const conflict = await publish(alice, folderReq('V', [], 'A', [n('two')]));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'conflict',
      target: { kind: 'folder', name: 'A', path: ['V'] },
      removes: { folders: 1, notes: 2 },
      visitorEdits: 0,
    });

    const res = await publish(alice, folderReq('V', [], 'A', [{ folderKey: null, title: 'two', body: 'two v2' }], { overwrite: true }));
    expect(res.statusCode).toBe(201);
    expect(res.json().vaultId).toBe(vaultId);

    const c = await content(alice);
    expect(c.folders.map((f) => f.name).sort()).toEqual(['A', 'B']);
    const a = c.folders.find((f) => f.name === 'A')!;
    const b = c.folders.find((f) => f.name === 'B')!;
    expect(c.notes.filter((x) => x.folderId === a.id).map((x) => x.title)).toEqual(['two']);
    expect(c.notes.filter((x) => x.folderId === b.id).map((x) => x.title)).toEqual(['sib']);
    expect(bodies(vaultId)).toEqual(['sib:sib body', 'two:two v2']);
  });

  it('note overwrite', async () => {
    const { vaultId } = (await publish(alice, vaultReq('V'))).json();
    expect((await publish(alice, noteReq('V', ['Topics'], 'Solo', 'v1'))).statusCode).toBe(201);

    const conflict = await publish(alice, noteReq('V', ['Topics'], 'Solo', 'v2'));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'conflict',
      target: { kind: 'note', name: 'Solo', path: ['V', 'Topics'] },
      removes: { folders: 0, notes: 1 },
      visitorEdits: 0,
    });
    expect(bodies(vaultId)).toContain('Solo:v1');

    // Same title elsewhere is not a conflict.
    expect((await publish(alice, noteReq('V', [], 'Solo', 'root'))).statusCode).toBe(201);

    expect((await publish(alice, noteReq('V', ['Topics'], 'Solo', 'v2', { overwrite: true }))).statusCode).toBe(201);
    expect(bodies(vaultId)).toEqual(['First:first body', 'Index:# Hello', 'Solo:root', 'Solo:v2']);
  });

  it('publishing a folder or note into a new vault creates the vault', async () => {
    const res = await publish(alice, noteReq('Fresh', [], 'Hi', 'hello'));
    expect(res.statusCode).toBe(201);
    const c = await content(alice);
    expect(c.vaults).toEqual([{ id: res.json().vaultId, name: 'Fresh', color: COLOR, updatedAt: expect.any(String) }]);
    expect(c.notes.map((n) => [n.title, n.folderId])).toEqual([['Hi', null]]);
  });

  it('publishing a folder into a missing destPath creates the folders', async () => {
    const { vaultId } = (await publish(alice, vaultReq('V'))).json();
    const req = folderReq('V', ['Topics', 'Deep', 'Deeper'], 'Leaf', [{ folderKey: 'sub', title: 'N', body: 'b' }], {
      folders: [{ key: 'sub', parentKey: null, name: 'Sub' }],
    });
    expect((await publish(alice, req)).statusCode).toBe(201);

    const c = await content(alice);
    const byId = new Map(c.folders.map((f) => [f.id, f]));
    const chain = (id: string | null): string[] => {
      const out: string[] = [];
      for (let f = id ? byId.get(id) : undefined; f; f = f.parentId ? byId.get(f.parentId) : undefined) out.unshift(f.name);
      return out;
    };
    const note = c.notes.find((n) => n.title === 'N')!;
    expect(chain(note.folderId)).toEqual(['Topics', 'Deep', 'Deeper', 'Leaf', 'Sub']);
    // The existing Topics folder was reused, not duplicated.
    expect(c.folders.filter((f) => f.name === 'Topics')).toHaveLength(1);
    expect(c.folders.every((f) => f.vaultId === vaultId)).toBe(true);
  });

  it('a failing publish rolls back', async () => {
    const { vaultId } = (await publish(alice, vaultReq('V'))).json();
    const before = await content(alice);

    const tooBig = vaultReq('V', {
      notes: [
        { folderKey: null, title: 'ok', body: 'fine' },
        { folderKey: null, title: 'big', body: 'x'.repeat(1024 * 1024 + 1) },
      ],
      overwrite: true,
    });
    const res = await publish(alice, tooBig);
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_large');
    expect(await content(alice)).toEqual(before);

    // A failure inside the store's transaction, after the old content was deleted and the new inserted, rolls back.
    const replace = vaultReq('V', { notes: [{ folderKey: null, title: 'ok', body: 'fine' }], overwrite: true });
    expect(() =>
      storePublish(t.app.db, alice.userId, replace, () => {
        throw new Error('quota');
      }),
    ).toThrow('quota');
    expect(await content(alice)).toEqual(before);
    expect(bodies(vaultId)).toEqual(['First:first body', 'Index:# Hello']);
  });

  it('accepts a large request under the 64 MiB limit', async () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({ folderKey: null, title: `n${i}`, body: 'y'.repeat(1024 * 1024) }));
    const res = await publish(alice, vaultReq('Big', { folders: [], notes }));
    expect(res.statusCode).toBe(201);
    expect((await content(alice)).notes).toHaveLength(5);
  });

  it('another user cannot see or delete my content', async () => {
    const { vaultId } = (await publish(alice, vaultReq('V'))).json();
    const c = await content(alice);
    expect(await content(bob)).toEqual({ vaults: [], folders: [], notes: [] });

    expect((await call(t.app, 'DELETE', `/api/openboard/vaults/${vaultId}`, { cookie: bob.cookie })).statusCode).toBe(404);
    expect((await call(t.app, 'DELETE', `/api/openboard/folders/${c.folders[0].id}`, { cookie: bob.cookie })).statusCode).toBe(404);
    expect((await call(t.app, 'DELETE', `/api/openboard/notes/${c.notes[0].id}`, { cookie: bob.cookie })).statusCode).toBe(404);
    expect(await content(alice)).toEqual(c);

    // Bob publishing a vault with the same name gets his own vault, not a conflict with Alice's.
    const mine = await publish(bob, vaultReq('V'));
    expect(mine.statusCode).toBe(201);
    expect(mine.json().vaultId).not.toBe(vaultId);
    expect(await content(alice)).toEqual(c);
  });

  it('unpublish a note, folder and vault', async () => {
    const { vaultId } = (await publish(alice, vaultReq('V'))).json();
    let c = await content(alice);
    const index = c.notes.find((n) => n.title === 'Index')!;
    const del = await call(t.app, 'DELETE', `/api/openboard/notes/${index.id}`, { cookie: alice.cookie });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    c = await content(alice);
    expect(c.notes.map((n) => n.title)).toEqual(['First']);

    expect((await call(t.app, 'DELETE', `/api/openboard/notes/${index.id}`, { cookie: alice.cookie })).statusCode).toBe(404);
    expect((await call(t.app, 'DELETE', `/api/openboard/notes/not-a-uuid`, { cookie: alice.cookie })).statusCode).toBe(400);
    expect((await call(t.app, 'DELETE', `/api/openboard/vaults/${vaultId}`)).statusCode).toBe(401);
  });

  it('unpublish a folder cascades', async () => {
    await publish(alice, vaultReq('V'));
    await publish(
      alice,
      folderReq('V', ['Topics'], 'Inner', [{ folderKey: 'g', title: 'Deep', body: 'd' }], {
        folders: [{ key: 'g', parentKey: null, name: 'Grand' }],
      }),
    );
    let c = await content(alice);
    expect(c.folders).toHaveLength(3);
    const topics = c.folders.find((f) => f.name === 'Topics')!;
    expect((await call(t.app, 'DELETE', `/api/openboard/folders/${topics.id}`, { cookie: alice.cookie })).statusCode).toBe(204);
    c = await content(alice);
    expect(c.folders).toEqual([]);
    expect(c.notes.map((n) => n.title)).toEqual(['Index']);
  });

  it('unpublish a vault removes link grants', async () => {
    const { vaultId } = (await publish(alice, vaultReq('V'))).json();
    const keep = (await publish(alice, vaultReq('W'))).json().vaultId;
    const db = t.app.db;
    const linkId = randomUUID();
    db.prepare("INSERT INTO ob_links (id, user_id, label, token, views, created_at) VALUES (?, ?, 'l', 'tok', 0, '2026-01-01')").run(
      linkId,
      alice.userId,
    );
    db.prepare('INSERT INTO ob_link_vaults (link_id, ob_vault_id) VALUES (?, ?), (?, ?)').run(linkId, vaultId, linkId, keep);

    // A vault overwrite keeps the grant.
    expect((await publish(alice, vaultReq('V', { overwrite: true }))).statusCode).toBe(201);
    expect(db.prepare('SELECT ob_vault_id FROM ob_link_vaults WHERE link_id = ? ORDER BY ob_vault_id').all(linkId)).toHaveLength(2);

    expect((await call(t.app, 'DELETE', `/api/openboard/vaults/${vaultId}`, { cookie: alice.cookie })).statusCode).toBe(204);
    expect(db.prepare('SELECT ob_vault_id FROM ob_link_vaults WHERE link_id = ?').all(linkId)).toEqual([{ ob_vault_id: keep }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ob_notes WHERE vault_id = ?').get(vaultId)).toEqual({ n: 0 });
    expect((await content(alice)).vaults.map((v) => v.name)).toEqual(['W']);
  });

  it('returns imageRefs', async () => {
    // Published image ids use the private image id charset (UUIDs).
    const imgA = randomUUID();
    const imgB = randomUUID();
    const res = await publish(
      alice,
      vaultReq('Pics', {
        folders: [],
        notes: [
          { folderKey: null, title: 'one', body: `![a](inked://${imgA}) and ![b](inked://${imgB})` },
          { folderKey: null, title: 'two', body: `again ![a](inked://${imgA}) and inked://not-an-id` },
        ],
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().imageRefs).toEqual([imgA, imgB]);
  });

  it('drops published images no longer referenced', async () => {
    const imgA = randomUUID();
    const imgB = randomUUID();
    const { vaultId } = (
      await publish(alice, vaultReq('Pics', { folders: [], notes: [{ folderKey: null, title: 'one', body: `![](inked://${imgA})` }] }))
    ).json();
    const db = t.app.db;
    const ins = db.prepare("INSERT INTO ob_images (vault_id, id, size, mime, data, created_at) VALUES (?, ?, 1, 'image/png', ?, '2026-01-01')");
    ins.run(vaultId, imgA, Buffer.from([1]));
    ins.run(vaultId, imgB, Buffer.from([1]));

    // Publishing a note into the vault drops imgB (unreferenced) and keeps imgA.
    expect((await publish(alice, noteReq('Pics', [], 'two', 'no images'))).statusCode).toBe(201);
    expect(db.prepare('SELECT id FROM ob_images WHERE vault_id = ?').all(vaultId)).toEqual([{ id: imgA }]);
  });

  it('duplicate sibling names and non-ASCII names publish and list', async () => {
    const req = vaultReq('Récherche 研究', {
      folders: [
        { key: 'a', parentKey: null, name: 'Dup' },
        { key: 'b', parentKey: null, name: 'Dup' },
        { key: 'c', parentKey: 'a', name: 'Ünïcødé 📚' },
      ],
      notes: [
        { folderKey: 'a', title: 'Same', body: '1' },
        { folderKey: 'b', title: 'Same', body: '2' },
        { folderKey: 'c', title: 'Same', body: '3' },
        { folderKey: 'c', title: 'Same', body: '4' },
      ],
    });
    expect((await publish(alice, req)).statusCode).toBe(201);
    let c = await content(alice);
    expect(c.vaults[0].name).toBe('Récherche 研究');
    expect(c.folders.map((f) => f.name).sort()).toEqual(['Dup', 'Dup', 'Ünïcødé 📚']);
    expect(c.notes).toHaveLength(4);

    // Duplicate siblings collide together: overwriting folder "Dup" replaces both.
    const conflict = await publish(alice, folderReq('Récherche 研究', [], 'Dup', [{ folderKey: null, title: 'Only', body: 'o' }]));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().removes).toEqual({ folders: 3, notes: 4 });
    const res = await publish(alice, folderReq('Récherche 研究', [], 'Dup', [{ folderKey: null, title: 'Only', body: 'o' }], { overwrite: true }));
    expect(res.statusCode).toBe(201);
    c = await content(alice);
    expect(c.folders.map((f) => f.name)).toEqual(['Dup']);
    expect(c.notes.map((n) => n.title)).toEqual(['Only']);

    // Duplicate notes collide together too.
    await publish(alice, noteReq('Récherche 研究', [], 'Twin', 'a'));
    await publish(alice, noteReq('Récherche 研究', [], 'Twin2', 'b'));
    t.app.db.prepare("UPDATE ob_notes SET title = 'Twin' WHERE title = 'Twin2'").run();
    const twin = await publish(alice, noteReq('Récherche 研究', [], 'Twin', 'c'));
    expect(twin.json().removes).toEqual({ folders: 0, notes: 2 });
    expect((await publish(alice, noteReq('Récherche 研究', [], 'Twin', 'c', { overwrite: true }))).statusCode).toBe(201);
    expect((await content(alice)).notes.filter((n) => n.title === 'Twin')).toHaveLength(1);
  });
});

describe('republishing over visitor edits', () => {
  const markVisitorEdited = (title: string) =>
    t.app.db.prepare("UPDATE ob_notes SET visitor_edited_at = '2026-10-24T00:00:00.000Z' WHERE title = ?").run(title);

  it('a vault conflict counts every visitor-edited note in the vault', async () => {
    expect((await publish(alice, vaultReq('Research'))).statusCode).toBe(201);
    markVisitorEdited('First');
    markVisitorEdited('Index');
    const res = await publish(alice, vaultReq('Research'));
    expect(res.statusCode).toBe(409);
    expect(res.json().visitorEdits).toBe(2);
  });

  it('folder and note conflicts count only their target', async () => {
    expect((await publish(alice, vaultReq('Research'))).statusCode).toBe(201);
    expect((await publish(alice, folderReq('Research', [], 'Other', [{ folderKey: null, title: 'Elsewhere', body: 'e' }]))).statusCode).toBe(201);
    markVisitorEdited('First');
    markVisitorEdited('Elsewhere');
    const folder = await publish(alice, folderReq('Research', [], 'Topics', [{ folderKey: null, title: 'First', body: 'x' }]));
    expect(folder.statusCode).toBe(409);
    expect(folder.json().visitorEdits).toBe(1);
    const note = await publish(alice, noteReq('Research', ['Topics'], 'First', 'x'));
    expect(note.statusCode).toBe(409);
    expect(note.json().visitorEdits).toBe(1);
    const clean = await publish(alice, noteReq('Research', [], 'Index', 'x'));
    expect(clean.statusCode).toBe(409);
    expect(clean.json().visitorEdits).toBe(0);
  });

  it('republishing a note a visitor renamed finds it by its published title and replaces it', async () => {
    expect((await publish(alice, vaultReq('Research'))).statusCode).toBe(201);
    t.app.db
      .prepare("UPDATE ob_notes SET title = 'First, renamed', visitor_edited_at = '2026-10-24T00:00:00.000Z' WHERE title = 'First'")
      .run();
    const conflict = await publish(alice, noteReq('Research', ['Topics'], 'First', 'owner again'));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ removes: { folders: 0, notes: 1 }, visitorEdits: 1 });
    expect((await publish(alice, noteReq('Research', ['Topics'], 'First', 'owner again', { overwrite: true }))).statusCode).toBe(201);
    const titles = (await content(alice)).notes.map((n) => n.title).sort();
    expect(titles).toEqual(['First', 'Index']);
  });

  it('an overwrite replaces visitor edits with owner content', async () => {
    expect((await publish(alice, vaultReq('Research'))).statusCode).toBe(201);
    markVisitorEdited('First');
    expect((await publish(alice, vaultReq('Research', { overwrite: true }))).statusCode).toBe(201);
    expect((await content(alice)).notes.map((n) => (n as { visitorEdited?: boolean }).visitorEdited)).toEqual([false, false]);
  });
});
