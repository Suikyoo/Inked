import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, call, fakeCipher, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

const MAX = 10 * 1024 * 1024 + 28;
const OCTET = { 'content-type': 'application/octet-stream' };

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

async function newVault(who: Account): Promise<string> {
  const id = randomUUID();
  const r = await call(t.app, 'POST', '/api/vaults', { cookie: who.cookie, body: { id, encMeta: fakeCipher(), wrappedKey: fakeCipher(60) } });
  expect(r.statusCode).toBe(200);
  return id;
}
const url = (vaultId: string, imageId: string) => `/api/vaults/${vaultId}/images/${imageId}`;
const put = (who: Account, vaultId: string, imageId: string, body: Buffer, headers: Record<string, string> = OCTET) =>
  call(t.app, 'POST', url(vaultId, imageId), { cookie: who.cookie, body, headers });
const get = (who: Account | null, vaultId: string, imageId: string) =>
  call(t.app, 'GET', url(vaultId, imageId), who ? { cookie: who.cookie } : {});
const countImages = () => {
  const db = new DatabaseSync(path.join(t.dataDir, 'inked.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe('image routes', () => {
  it('stores a blob and returns it byte for byte with immutable caching', async () => {
    const vaultId = await newVault(alice);
    const id = randomUUID();
    const blob = randomBytes(100);
    const r = await put(alice, vaultId, id, blob);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id, size: 100 });
    const g = await get(alice, vaultId, id);
    expect(g.statusCode).toBe(200);
    expect(Buffer.compare(g.rawPayload, blob)).toBe(0);
    expect(g.headers['content-type']).toBe('application/octet-stream');
    expect(g.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(g.headers['x-content-type-options']).toBe('nosniff');
  });
  it('keeps no-store on every other API route', async () => {
    const r = await call(t.app, 'GET', '/api/vaults', { cookie: alice.cookie });
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('requires a session', async () => {
    const vaultId = await newVault(alice);
    const id = randomUUID();
    expect((await call(t.app, 'POST', url(vaultId, id), { body: randomBytes(64), headers: OCTET })).statusCode).toBe(401);
    expect((await get(null, vaultId, id)).statusCode).toBe(401);
  });
  it('answers 404 for another user vault, an unknown image, and the right id in the wrong vault', async () => {
    const aliceVault = await newVault(alice);
    const aliceVault2 = await newVault(alice);
    const id = randomUUID();
    expect((await put(alice, aliceVault, id, randomBytes(64))).statusCode).toBe(201);
    expect((await put(bob, aliceVault, randomUUID(), randomBytes(64))).statusCode).toBe(404);
    expect((await get(bob, aliceVault, id)).statusCode).toBe(404);
    expect((await get(alice, aliceVault, randomUUID())).statusCode).toBe(404);
    expect((await get(alice, aliceVault2, id)).statusCode).toBe(404);
  });
  it('refuses a JSON body, a missing content type, a short body, a duplicate id and a bad uuid', async () => {
    const vaultId = await newVault(alice);
    const json = await call(t.app, 'POST', url(vaultId, randomUUID()), { cookie: alice.cookie, body: { a: 1 } });
    expect(json.statusCode).toBe(415);
    const none = await put(alice, vaultId, randomUUID(), randomBytes(64), {});
    expect(none.statusCode).toBe(415);
    expect((await put(alice, vaultId, randomUUID(), randomBytes(28))).statusCode).toBe(400);
    const id = randomUUID();
    expect((await put(alice, vaultId, id, randomBytes(29))).statusCode).toBe(201);
    const dup = await put(alice, vaultId, id, randomBytes(64));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('exists');
    expect((await put(alice, vaultId, 'not-a-uuid', randomBytes(64))).statusCode).toBe(400);
  });
  it('accepts exactly 10 MiB + 28 bytes and refuses one more (a 10 MiB image plus iv and tag)', async () => {
    const vaultId = await newVault(alice);
    expect((await put(alice, vaultId, randomUUID(), Buffer.alloc(MAX, 1))).statusCode).toBe(201);
    const over = await put(alice, vaultId, randomUUID(), Buffer.alloc(MAX + 1, 1));
    expect(over.statusCode).toBe(413);
    expect(over.json().error).toBe('too_large');
  });
  it('enforces the per-user quota, per user', async () => {
    await t.close();
    t = await makeApp({ imageQuotaBytes: 100 });
    alice = await setupAdmin(t.app, 'alice');
    bob = await inviteUser(t.app, alice, 'bob');
    const av = await newVault(alice);
    const bv = await newVault(bob);
    expect((await put(alice, av, randomUUID(), randomBytes(60))).statusCode).toBe(201);
    const full = await put(alice, av, randomUUID(), randomBytes(60));
    expect(full.statusCode).toBe(413);
    expect(full.json().error).toBe('quota_exceeded');
    expect(countImages()).toBe(1);
    expect((await put(bob, bv, randomUUID(), randomBytes(60))).statusCode).toBe(201);
    expect((await put(alice, av, randomUUID(), randomBytes(40))).statusCode).toBe(201);
  });
  it('does not accept octet-stream on other routes', async () => {
    const r = await call(t.app, 'POST', '/api/auth/login', { body: randomBytes(1024), headers: OCTET });
    expect(r.statusCode).toBe(415);
    const big = await call(t.app, 'POST', '/api/auth/login', { body: randomBytes(5 * 1024 * 1024), headers: OCTET });
    expect(big.statusCode).toBe(415);
    const vaultId = await newVault(alice);
    expect((await put(alice, vaultId, randomUUID(), randomBytes(64))).statusCode).toBe(201);
  });
  it('deletes images with their vault', async () => {
    const vaultId = await newVault(alice);
    await put(alice, vaultId, randomUUID(), randomBytes(64));
    expect(countImages()).toBe(1);
    expect((await call(t.app, 'DELETE', `/api/vaults/${vaultId}`, { cookie: alice.cookie })).statusCode).toBe(200);
    expect(countImages()).toBe(0);
  });
});
