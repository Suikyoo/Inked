import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sniffImage } from '../src/openboard/store.js';
import { type Account, call, fakeCipher, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

const OCTET = { 'content-type': 'application/octet-stream' };
const MIB10 = 10 * 1024 * 1024;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size = 64) => Buffer.concat([PNG_SIG, randomBytes(Math.max(0, size - PNG_SIG.length))]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(60)]);
const gif = (v: '87a' | '89a') => Buffer.concat([Buffer.from(`GIF${v}`), randomBytes(60)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), randomBytes(4), Buffer.from('WEBP'), randomBytes(60)]);

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

/** Publishes a vault whose note body references the given image ids. */
async function publishWith(who: Account, name: string, imageIds: string[]): Promise<string> {
  const body = imageIds.map((id) => `![pic](inked://${id})`).join('\n') || 'no images';
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

const upload = (who: Account, vaultId: string, imageId: string, body: Buffer, headers: Record<string, string> = OCTET) =>
  call(t.app, 'POST', `/api/openboard/vaults/${vaultId}/images/${imageId}`, { cookie: who.cookie, body, headers });

const stored = () =>
  t.app.db.prepare('SELECT vault_id, id, size, mime, data FROM ob_images ORDER BY rowid').all() as {
    vault_id: string;
    id: string;
    size: number;
    mime: string;
    data: Uint8Array;
  }[];

describe('sniffImage', () => {
  it('recognises png, jpeg, gif and webp', () => {
    expect(sniffImage(png())).toBe('image/png');
    expect(sniffImage(jpeg())).toBe('image/jpeg');
    expect(sniffImage(gif('87a'))).toBe('image/gif');
    expect(sniffImage(gif('89a'))).toBe('image/gif');
    expect(sniffImage(webp())).toBe('image/webp');
  });
  it('rejects everything else', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
    expect(sniffImage(Buffer.from('GIF88a'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(PNG_SIG.subarray(0, 7))).toBeNull();
  });
});

describe('openboard published images', () => {
  it('uploads PNG bytes and stores them with the sniffed mime', async () => {
    const id = randomUUID();
    const vaultId = await publishWith(alice, 'A', [id]);
    const bytes = png(200);
    const res = await upload(alice, vaultId, id, bytes);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id, size: 200 });
    const [row] = stored();
    expect(row).toMatchObject({ vault_id: vaultId, id, size: 200, mime: 'image/png' });
    expect(Buffer.compare(Buffer.from(row.data), bytes)).toBe(0);
  });

  it('stores jpeg, gif and webp with their mime types', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const vaultId = await publishWith(alice, 'A', ids);
    expect((await upload(alice, vaultId, ids[0], jpeg())).statusCode).toBe(201);
    expect((await upload(alice, vaultId, ids[1], gif('89a'))).statusCode).toBe(201);
    expect((await upload(alice, vaultId, ids[2], webp())).statusCode).toBe(201);
    expect(stored().map((r) => r.mime)).toEqual(['image/jpeg', 'image/gif', 'image/webp']);
  });

  it('rejects SVG and other non-images with 400', async () => {
    const id = randomUUID();
    const vaultId = await publishWith(alice, 'A', [id]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await upload(alice, vaultId, id, svg);
    expect(res.statusCode).toBe(400);
    expect((await upload(alice, vaultId, id, randomBytes(100))).statusCode).toBe(400);
    expect((await upload(alice, vaultId, id, Buffer.alloc(0))).statusCode).toBe(400);
    expect(stored()).toEqual([]);
  });

  it('accepts only application/octet-stream (415 otherwise)', async () => {
    const id = randomUUID();
    const vaultId = await publishWith(alice, 'A', [id]);
    expect((await upload(alice, vaultId, id, png(), { 'content-type': 'image/svg+xml' })).statusCode).toBe(415);
    expect((await upload(alice, vaultId, id, png(), { 'content-type': 'image/png' })).statusCode).toBe(415);
    const json = await call(t.app, 'POST', `/api/openboard/vaults/${vaultId}/images/${id}`, {
      cookie: alice.cookie,
      body: { data: 'x' },
    });
    expect(json.statusCode).toBe(415);
    expect(stored()).toEqual([]);
  });

  it('accepts exactly 10 MiB and rejects 10 MiB + 1 with 413', async () => {
    const ok = randomUUID();
    const big = randomUUID();
    const vaultId = await publishWith(alice, 'A', [ok, big]);
    expect((await upload(alice, vaultId, ok, png(MIB10))).statusCode).toBe(201);
    const over = await upload(alice, vaultId, big, png(MIB10 + 1));
    expect(over.statusCode).toBe(413);
    expect(stored().map((r) => r.id)).toEqual([ok]);
  });

  it('is 404 when no note body in the vault references the id', async () => {
    const referenced = randomUUID();
    const a = await publishWith(alice, 'A', [referenced]);
    const otherId = randomUUID();
    await publishWith(alice, 'B', [otherId]);
    expect((await upload(alice, a, randomUUID(), png())).statusCode).toBe(404);
    // Referenced in a different vault only.
    expect((await upload(alice, a, otherId, png())).statusCode).toBe(404);
    expect(stored()).toEqual([]);
  });

  it("is 404 for another user's or an unknown published vault", async () => {
    const id = randomUUID();
    const bv = await publishWith(bob, 'B', [id]);
    expect((await upload(alice, bv, id, png())).statusCode).toBe(404);
    expect((await upload(alice, randomUUID(), id, png())).statusCode).toBe(404);
    expect(stored()).toEqual([]);
  });

  it('rejects a duplicate with 409', async () => {
    const id = randomUUID();
    const vaultId = await publishWith(alice, 'A', [id]);
    expect((await upload(alice, vaultId, id, png())).statusCode).toBe(201);
    const dup = await upload(alice, vaultId, id, png());
    expect(dup.statusCode).toBe(409);
    expect(stored()).toHaveLength(1);
  });

  it('requires a session', async () => {
    const id = randomUUID();
    const vaultId = await publishWith(alice, 'A', [id]);
    const r = await call(t.app, 'POST', `/api/openboard/vaults/${vaultId}/images/${id}`, { body: png(), headers: OCTET });
    expect(r.statusCode).toBe(401);
  });

  it('counts private and published bytes together against the per-user quota', async () => {
    await t.close();
    t = await makeApp({ imageQuotaBytes: 100 });
    alice = await setupAdmin(t.app, 'alice');
    bob = await inviteUser(t.app, alice, 'bob');

    const privateVault = randomUUID();
    const pv = await call(t.app, 'POST', '/api/vaults', {
      cookie: alice.cookie,
      body: { id: privateVault, encMeta: fakeCipher(), wrappedKey: fakeCipher(60) },
    });
    expect(pv.statusCode).toBe(200);
    const priv = await call(t.app, 'POST', `/api/vaults/${privateVault}/images/${randomUUID()}`, {
      cookie: alice.cookie,
      body: randomBytes(60),
      headers: OCTET,
    });
    expect(priv.statusCode).toBe(201);

    const [i1, i2, i3] = [randomUUID(), randomUUID(), randomUUID()];
    const vaultId = await publishWith(alice, 'A', [i1, i2, i3]);
    const full = await upload(alice, vaultId, i1, png(60));
    expect(full.statusCode).toBe(413);
    expect(full.json().error).toBe('quota_exceeded');
    expect((await upload(alice, vaultId, i2, png(40))).statusCode).toBe(201);

    // Published bytes count against later private uploads too.
    const privFull = await call(t.app, 'POST', `/api/vaults/${privateVault}/images/${randomUUID()}`, {
      cookie: alice.cookie,
      body: randomBytes(30),
      headers: OCTET,
    });
    expect(privFull.statusCode).toBe(413);

    // Quota is per user.
    const bid = randomUUID();
    const bv = await publishWith(bob, 'B', [bid]);
    expect((await upload(bob, bv, bid, png(90))).statusCode).toBe(201);
  });
});
