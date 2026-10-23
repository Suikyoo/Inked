import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLink } from '../src/openboard/store.js';
import { LINK_TOKEN_RE } from '../src/openboard/token.js';
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

interface Link {
  id: string;
  label: string;
  token: string;
  vaultIds: string[];
  views: number;
  permission: string;
  createdAt: string;
}

async function publishVault(who: Account, name: string, body = `${name} body`): Promise<string> {
  const res = await call(t.app, 'POST', '/api/openboard/publish', {
    cookie: who.cookie,
    body: {
      kind: 'vault',
      vaultName: name,
      color: '#45A89E',
      destPath: [],
      rootName: name,
      folders: [],
      notes: [{ folderKey: null, title: 'Index', body }],
      overwrite: false,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().vaultId;
}

const create = (who: Account, body: unknown) => call(t.app, 'POST', '/api/openboard/links', { cookie: who.cookie, body });
const patch = (who: Account, id: string, body: unknown) =>
  call(t.app, 'PATCH', `/api/openboard/links/${id}`, { cookie: who.cookie, body });
const del = (who: Account, id: string) => call(t.app, 'DELETE', `/api/openboard/links/${id}`, { cookie: who.cookie });
const list = async (who: Account): Promise<Link[]> => {
  const res = await call(t.app, 'GET', '/api/openboard/links', { cookie: who.cookie });
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe('openboard links', () => {
  it('creates a link over two vaults with a whimsy token and no views', async () => {
    const a = await publishVault(alice, 'A');
    const b = await publishVault(alice, 'B');
    const res = await create(alice, { label: 'Friends', vaultIds: [a, b] });
    expect(res.statusCode).toBe(201);
    const link: Link = res.json();
    expect(link.label).toBe('Friends');
    expect(link.token).toMatch(LINK_TOKEN_RE);
    expect(link.views).toBe(0);
    expect([...link.vaultIds].sort()).toEqual([a, b].sort());
    expect(Date.parse(link.createdAt)).not.toBeNaN();
    expect(await list(alice)).toEqual([link]);
  });

  it('validates the label length', async () => {
    const a = await publishVault(alice, 'A');
    expect((await create(alice, { label: '', vaultIds: [a] })).statusCode).toBe(400);
    expect((await create(alice, { label: 'x'.repeat(81), vaultIds: [a] })).statusCode).toBe(400);
    expect((await create(alice, { label: 'x'.repeat(80), vaultIds: [a] })).statusCode).toBe(201);
    expect((await create(alice, { label: 'x', vaultIds: [a] })).statusCode).toBe(201);
  });

  it("rejects another user's or an unknown vault", async () => {
    const a = await publishVault(alice, 'A');
    const bv = await publishVault(bob, 'B');
    const foreign = await create(alice, { label: 'L', vaultIds: [a, bv] });
    expect(foreign.statusCode).toBe(400);
    const unknown = await create(alice, { label: 'L', vaultIds: [randomUUID()] });
    expect(unknown.statusCode).toBe(400);
    expect(await list(alice)).toEqual([]);
  });

  it('defaults a new link to read, and accepts write', async () => {
    const a = await publishVault(alice, 'A');
    const plain = await create(alice, { label: 'Plain', vaultIds: [a] });
    expect(plain.statusCode).toBe(201);
    expect(plain.json().permission).toBe('read');
    const writable = await create(alice, { label: 'Open', vaultIds: [a], permission: 'write' });
    expect(writable.statusCode).toBe(201);
    expect(writable.json().permission).toBe('write');
    expect((await list(alice)).map((l) => [l.label, l.permission])).toEqual([
      ['Plain', 'read'],
      ['Open', 'write'],
    ]);
  });

  it('rejects an unknown permission on create and PATCH', async () => {
    const a = await publishVault(alice, 'A');
    expect((await create(alice, { label: 'X', vaultIds: [a], permission: 'admin' })).statusCode).toBe(400);
    const link = (await create(alice, { label: 'X', vaultIds: [a] })).json();
    expect((await patch(alice, link.id, { permission: 'admin' })).statusCode).toBe(400);
    expect((await list(alice))[0].permission).toBe('read');
  });

  it('PATCH changes the permission and keeps the vaults', async () => {
    const a = await publishVault(alice, 'A');
    const link = (await create(alice, { label: 'X', vaultIds: [a] })).json();
    const up = await patch(alice, link.id, { permission: 'write' });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ permission: 'write', vaultIds: [a] });
    const down = await patch(alice, link.id, { permission: 'read' });
    expect(down.json().permission).toBe('read');
  });

  it('lists only my links', async () => {
    const a = await publishVault(alice, 'A');
    const bv = await publishVault(bob, 'B');
    const mine = (await create(alice, { label: 'Mine', vaultIds: [a] })).json();
    await create(bob, { label: 'Theirs', vaultIds: [bv] });
    expect((await list(alice)).map((l) => l.id)).toEqual([mine.id]);
  });

  it('PATCH replaces the vault set and can rename', async () => {
    const a = await publishVault(alice, 'A');
    const b = await publishVault(alice, 'B');
    const c = await publishVault(alice, 'C');
    const link: Link = (await create(alice, { label: 'L', vaultIds: [a, b] })).json();
    const res = await patch(alice, link.id, { vaultIds: [c] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...link, vaultIds: [c] });
    const renamed = await patch(alice, link.id, { label: 'New' });
    expect(renamed.json()).toEqual({ ...link, label: 'New', vaultIds: [c] });
    expect(await list(alice)).toEqual([{ ...link, label: 'New', vaultIds: [c] }]);
  });

  it('PATCH with a foreign vault changes nothing', async () => {
    const a = await publishVault(alice, 'A');
    const bv = await publishVault(bob, 'B');
    const link: Link = (await create(alice, { label: 'L', vaultIds: [a] })).json();
    expect((await patch(alice, link.id, { label: 'X', vaultIds: [bv] })).statusCode).toBe(400);
    expect(await list(alice)).toEqual([link]);
    expect((await patch(alice, link.id, { label: '' })).statusCode).toBe(400);
  });

  it('DELETE removes the link; a second DELETE is 404', async () => {
    const a = await publishVault(alice, 'A');
    const link: Link = (await create(alice, { label: 'L', vaultIds: [a] })).json();
    expect((await del(alice, link.id)).statusCode).toBe(204);
    expect(await list(alice)).toEqual([]);
    expect((await del(alice, link.id)).statusCode).toBe(404);
    const grants = t.app.db.prepare('SELECT COUNT(*) AS n FROM ob_link_vaults').get() as { n: number };
    expect(grants.n).toBe(0);
  });

  it("another user's link is 404 on PATCH and DELETE", async () => {
    const a = await publishVault(alice, 'A');
    const bv = await publishVault(bob, 'B');
    const link: Link = (await create(alice, { label: 'L', vaultIds: [a] })).json();
    expect((await patch(bob, link.id, { label: 'Mine now' })).statusCode).toBe(404);
    expect((await patch(bob, link.id, { vaultIds: [bv] })).statusCode).toBe(404);
    expect((await del(bob, link.id)).statusCode).toBe(404);
    expect(await list(alice)).toEqual([link]);
  });

  it('requires a session', async () => {
    expect((await call(t.app, 'GET', '/api/openboard/links')).statusCode).toBe(401);
    expect((await call(t.app, 'POST', '/api/openboard/links', { body: { label: 'L', vaultIds: [] } })).statusCode).toBe(401);
  });

  it('retries token generation on a collision, then fails with 500', () => {
    const userId = alice.userId;
    const tokens = ['dup-token-aaaaaaaaaaaa', 'dup-token-aaaaaaaaaaaa', 'fresh-token-bbbbbbbbbbbb'];
    let i = 0;
    const first = createLink(t.app.db, userId, { label: 'One', vaultIds: [] }, () => tokens[i++]);
    expect(first.token).toBe('dup-token-aaaaaaaaaaaa');
    const second = createLink(t.app.db, userId, { label: 'Two', vaultIds: [] }, () => tokens[i++]);
    expect(second.token).toBe('fresh-token-bbbbbbbbbbbb');
    let calls = 0;
    const stuck = () => {
      calls++;
      return 'dup-token-aaaaaaaaaaaa';
    };
    expect(() => createLink(t.app.db, userId, { label: 'Three', vaultIds: [] }, stuck)).toThrow(
      expect.objectContaining({ statusCode: 500 }),
    );
    expect(calls).toBe(5);
    const n = (t.app.db.prepare('SELECT COUNT(*) AS n FROM ob_links').get() as { n: number }).n;
    expect(n).toBe(2);
  });
});

describe('openboard preview', () => {
  const preview = (who: Account, linkId?: string) =>
    call(t.app, 'GET', `/api/openboard/preview${linkId ? `?linkId=${linkId}` : ''}`, { cookie: who.cookie });

  it("returns only the link's vaults, with bodies, without counting a view", async () => {
    const a = await publishVault(alice, 'A', 'alpha text');
    const b = await publishVault(alice, 'B', 'beta text');
    await publishVault(alice, 'C', 'gamma text');
    const link: Link = (await create(alice, { label: 'L', vaultIds: [a, b] })).json();
    const res = await preview(alice, link.id);
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.vaults.map((v: { id: string }) => v.id).sort()).toEqual([a, b].sort());
    expect(payload.notes.map((n: { body: string }) => n.body).sort()).toEqual(['alpha text', 'beta text']);
    expect(payload.notes.every((n: { vaultId: string }) => n.vaultId === a || n.vaultId === b)).toBe(true);
    expect((await list(alice))[0].views).toBe(0);
  });

  it('returns all my published content with bodies when linkId is omitted', async () => {
    await publishVault(alice, 'A', 'alpha text');
    await publishVault(alice, 'C', 'gamma text');
    await publishVault(bob, 'B', 'bob text');
    const res = await preview(alice);
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.vaults.map((v: { name: string }) => v.name)).toEqual(['A', 'C']);
    expect(payload.notes.map((n: { body: string }) => n.body).sort()).toEqual(['alpha text', 'gamma text']);
  });

  it("is 404 for another user's or an unknown link", async () => {
    const bv = await publishVault(bob, 'B', 'bob text');
    const link: Link = (await create(bob, { label: 'L', vaultIds: [bv] })).json();
    expect((await preview(alice, link.id)).statusCode).toBe(404);
    expect((await preview(alice, randomUUID())).statusCode).toBe(404);
    expect((await preview(alice, 'not-a-uuid')).statusCode).toBe(400);
  });
});
