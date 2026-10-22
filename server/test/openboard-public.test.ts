import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Account, call, makeApp, setupAdmin, type TestApp } from './helpers.js';

const OCTET = { 'content-type': 'application/octet-stream' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size = 64) => Buffer.concat([PNG_SIG, randomBytes(size - PNG_SIG.length)]);

let t: TestApp;
let alice: Account;
beforeEach(async () => {
  t = await makeApp();
  alice = await setupAdmin(t.app, 'alice');
});
afterEach(async () => {
  vi.useRealTimers();
  await t.close();
});

interface Link {
  id: string;
  token: string;
  views: number;
}

async function publishVault(name: string, notes: { title: string; body: string }[]): Promise<string> {
  const res = await call(t.app, 'POST', '/api/openboard/publish', {
    cookie: alice.cookie,
    body: {
      kind: 'vault',
      vaultName: name,
      color: '#45A89E',
      destPath: [],
      rootName: name,
      folders: [{ key: 'f', parentKey: null, name: `${name} folder` }],
      notes: notes.map((n) => ({ folderKey: 'f', ...n })),
      overwrite: false,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().vaultId;
}

const createLink = async (label: string, vaultIds: string[]): Promise<Link> => {
  const res = await call(t.app, 'POST', '/api/openboard/links', { cookie: alice.cookie, body: { label, vaultIds } });
  expect(res.statusCode).toBe(201);
  return res.json();
};
const listLinks = async (): Promise<Link[]> => (await call(t.app, 'GET', '/api/openboard/links', { cookie: alice.cookie })).json();
const upload = (vaultId: string, imageId: string, body: Buffer) =>
  call(t.app, 'POST', `/api/openboard/vaults/${vaultId}/images/${imageId}`, { cookie: alice.cookie, body, headers: OCTET });

/** A visitor's request: GET, no cookie, no CSRF header. */
const visit = (url: string, ip = '10.0.0.1') => t.app.inject({ method: 'GET', url, remoteAddress: ip });

describe('public token API', () => {
  it('returns only granted vaults, with bodies and the label', async () => {
    const a = await publishVault('Alpha', [{ title: 'Apple note', body: 'apple body' }]);
    await publishVault('Beta', [{ title: 'Banana secret', body: 'banana body' }]);
    const link = await createLink('Friends', [a]);
    const res = await visit(`/api/ob/${link.token}`);
    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.label).toBe('Friends');
    expect(payload.vaults.map((v: { id: string }) => v.id)).toEqual([a]);
    expect(payload.folders.map((f: { name: string }) => f.name)).toEqual(['Alpha folder']);
    expect(payload.notes.map((n: { title: string; body: string }) => [n.title, n.body])).toEqual([['Apple note', 'apple body']]);
    expect(res.body).not.toContain('Banana');
    expect(res.body).not.toContain('banana');
    expect(res.body).not.toContain('Beta');
  });

  it('counts one view per call; owner preview does not change it', async () => {
    const a = await publishVault('Alpha', [{ title: 'n', body: 'b' }]);
    const link = await createLink('L', [a]);
    for (let i = 0; i < 3; i++) expect((await visit(`/api/ob/${link.token}`)).statusCode).toBe(200);
    expect((await listLinks())[0].views).toBe(3);
    const preview = await call(t.app, 'GET', `/api/openboard/preview?linkId=${link.id}`, { cookie: alice.cookie });
    expect(preview.statusCode).toBe(200);
    expect((await listLinks())[0].views).toBe(3);
  });

  it('a HEAD request does not count a view; a GET does', async () => {
    const a = await publishVault('Alpha', [{ title: 'n', body: 'b' }]);
    const link = await createLink('L', [a]);
    const head = await t.app.inject({ method: 'HEAD', url: `/api/ob/${link.token}`, remoteAddress: '10.0.0.1' });
    expect(head.statusCode).toBe(200);
    expect((await listLinks())[0].views).toBe(0);
    expect((await visit(`/api/ob/${link.token}`)).statusCode).toBe(200);
    expect((await listLinks())[0].views).toBe(1);
  });

  it('sends X-Robots-Tag noindex on public lookups and their 404s', async () => {
    const a = await publishVault('Alpha', [{ title: 'n', body: 'b' }]);
    const link = await createLink('L', [a]);
    const ok = await visit(`/api/ob/${link.token}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-robots-tag']).toBe('noindex, nofollow');
    const miss = await visit('/api/ob/not-a-real-token');
    expect(miss.statusCode).toBe(404);
    expect(miss.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('edited grants take effect immediately', async () => {
    const a = await publishVault('Alpha', [{ title: 'Apple note', body: 'x' }]);
    const b = await publishVault('Beta', [{ title: 'Banana note', body: 'y' }]);
    const link = await createLink('L', [a]);
    expect((await visit(`/api/ob/${link.token}`)).json().vaults.map((v: { id: string }) => v.id)).toEqual([a]);
    const res = await call(t.app, 'PATCH', `/api/openboard/links/${link.id}`, { cookie: alice.cookie, body: { vaultIds: [b] } });
    expect(res.statusCode).toBe(200);
    const after = await visit(`/api/ob/${link.token}`);
    expect(after.json().vaults.map((v: { id: string }) => v.id)).toEqual([b]);
    expect(after.body).not.toContain('Apple');
  });

  it('deleted link, unknown token and malformed token are identical 404s; malformed skips the DB', async () => {
    const a = await publishVault('Alpha', [{ title: 'n', body: 'b' }]);
    const link = await createLink('L', [a]);
    expect((await call(t.app, 'DELETE', `/api/openboard/links/${link.id}`, { cookie: alice.cookie })).statusCode).toBe(204);
    const deleted = await visit(`/api/ob/${link.token}`);
    const unknown = await visit('/api/ob/jolly-otter-in-the-sun-abcdefghijkl');
    const prepare = vi.spyOn(t.app.db, 'prepare');
    const malformed = await visit('/api/ob/NOT_A_TOKEN');
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    for (const r of [deleted, unknown, malformed]) {
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: 'not_found' });
      expect(r.body).toBe(deleted.body);
    }
  });

  it('rate limits failures per ip; a locked ip is refused even with a valid token until the lock clears', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const a = await publishVault('Alpha', [{ title: 'n', body: 'b' }]);
    const link = await createLink('L', [a]);
    const bad = '/api/ob/jolly-otter-in-the-sun-abcdefghijkl';
    let last;
    for (let i = 0; i < 21; i++) last = await visit(bad, '10.0.0.9');
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
    // A different ip is unaffected.
    expect((await visit(`/api/ob/${link.token}`, '10.0.0.10')).statusCode).toBe(200);
    // The locked ip is refused even for a valid token, and for images.
    expect((await visit(`/api/ob/${link.token}`, '10.0.0.9')).statusCode).toBe(429);
    expect((await visit(`/api/ob/${link.token}/images/${a}/${randomUUID()}`, '10.0.0.9')).statusCode).toBe(429);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await visit(`/api/ob/${link.token}`, '10.0.0.9')).statusCode).toBe(200);
  });

  it('successful lookups do not count toward the limit', async () => {
    const a = await publishVault('Alpha', [{ title: 'n', body: 'b' }]);
    const link = await createLink('L', [a]);
    for (let i = 0; i < 30; i++) expect((await visit(`/api/ob/${link.token}`, '10.0.0.7')).statusCode).toBe(200);
  });

  it('serves an image only if its vault is granted, with safe headers', async () => {
    const ia = randomUUID();
    const ib = randomUUID();
    const a = await publishVault('Alpha', [{ title: 'n', body: `![x](inked://${ia})` }]);
    const b = await publishVault('Beta', [{ title: 'n', body: `![x](inked://${ib})` }]);
    const bytesA = png(100);
    expect((await upload(a, ia, bytesA)).statusCode).toBe(201);
    expect((await upload(b, ib, png(100))).statusCode).toBe(201);
    const link = await createLink('L', [a]);

    const denied = await visit(`/api/ob/${link.token}/images/${b}/${ib}`);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ error: 'not_found' });
    // Image of A requested under vault B's id is not found either.
    expect((await visit(`/api/ob/${link.token}/images/${b}/${ia}`)).statusCode).toBe(404);
    expect((await visit(`/api/ob/${link.token}/images/${a}/${randomUUID()}`)).statusCode).toBe(404);
    expect((await visit(`/api/ob/${link.token}/images/not-a-uuid/${ia}`)).statusCode).toBe(404);
    expect((await visit(`/api/ob/jolly-otter-in-the-sun-abcdefghijkl/images/${a}/${ia}`)).statusCode).toBe(404);

    const ok = await visit(`/api/ob/${link.token}/images/${a}/${ia}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['content-disposition']).toBe('inline');
    expect(ok.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(ok.headers['cache-control']).toBe('private, max-age=3600');
    expect(Buffer.compare(ok.rawPayload, bytesA)).toBe(0);
  });

  it('serves a GIF-prefixed HTML payload as image/gif under a sandbox CSP', async () => {
    const id = randomUUID();
    const a = await publishVault('Alpha', [{ title: 'n', body: `![x](inked://${id})` }]);
    const evil = Buffer.from('GIF89a<html><script>alert(1)</script></html>');
    expect((await upload(a, id, evil)).statusCode).toBe(201);
    const link = await createLink('L', [a]);
    const res = await visit(`/api/ob/${link.token}/images/${a}/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('resolves an image id shared by two vaults by the vault in the URL', async () => {
    const id = randomUUID();
    const a = await publishVault('Alpha', [{ title: 'n', body: `![x](inked://${id})` }]);
    const b = await publishVault('Beta', [{ title: 'n', body: `![x](inked://${id})` }]);
    const bytesA = png(80);
    const bytesB = png(90);
    expect((await upload(a, id, bytesA)).statusCode).toBe(201);
    expect((await upload(b, id, bytesB)).statusCode).toBe(201);
    const link = await createLink('L', [a, b]);
    const ra = await visit(`/api/ob/${link.token}/images/${a}/${id}`);
    const rb = await visit(`/api/ob/${link.token}/images/${b}/${id}`);
    expect(Buffer.compare(ra.rawPayload, bytesA)).toBe(0);
    expect(Buffer.compare(rb.rawPayload, bytesB)).toBe(0);
  });

  it('the JSON response is not cached', async () => {
    const a = await publishVault('Alpha', [{ title: 'n', body: 'b' }]);
    const link = await createLink('L', [a]);
    const res = await visit(`/api/ob/${link.token}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('a link granting zero vaults returns empty arrays', async () => {
    const link = await createLink('Empty', []);
    const res = await visit(`/api/ob/${link.token}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ label: 'Empty', vaults: [], folders: [], notes: [] });
  });

  it('only GET is routed', async () => {
    const link = await createLink('L', []);
    const res = await call(t.app, 'POST', `/api/ob/${link.token}`, { body: {} });
    expect(res.statusCode).toBe(404);
  });
});
