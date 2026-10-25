import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, key32, makeApp, setupAdmin, setupBody, type TestApp } from './helpers.js';

let t: TestApp | undefined;
let webDist: string | undefined;
afterEach(async () => {
  await t?.close();
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  t = undefined;
  webDist = undefined;
});

const EXPECTED_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

describe('CSRF header', () => {
  it('is required on non-GET requests', async () => {
    t = await makeApp();
    const missing = await t.app.inject({ method: 'POST', url: '/api/setup', payload: setupBody('admin') });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error).toBe('csrf');

    const wrong = await call(t.app, 'POST', '/api/setup', { body: setupBody('admin'), headers: { 'x-inked': '0' } });
    expect(wrong.statusCode).toBe(403);

    // Nothing was created.
    expect((await call(t.app, 'GET', '/api/status')).json()).toEqual({ needsSetup: true, llmOrigins: [] });

    const admin = await setupAdmin(t.app);
    const del = await t.app.inject({
      method: 'DELETE',
      url: '/api/vaults/00000000-0000-4000-8000-000000000000',
      headers: { cookie: `inked_session=${admin.cookie}` },
    });
    expect(del.statusCode).toBe(403);
  });

  it('is not required on GET', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
  });
});

describe('security headers', () => {
  it('are on API responses, errors and 404s', async () => {
    t = await makeApp();
    const responses = [
      await call(t.app, 'GET', '/api/status'),
      await call(t.app, 'GET', '/api/me'),
      await call(t.app, 'GET', '/api/does-not-exist'),
      await t.app.inject({ method: 'POST', url: '/api/setup' }),
    ];
    for (const res of responses) {
      expect(res.headers).toMatchObject(EXPECTED_HEADERS);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('treats an empty JSON body as no body', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'x-inked': '1', 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects malformed JSON with 400', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-inked': '1', 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });
});

describe('server secret', () => {
  it('is created once, 32 bytes, and reused', async () => {
    t = await makeApp();
    const file = path.join(t.dataDir, 'server-secret');
    expect(existsSync(file)).toBe(true);
    const secret = readFileSync(file);
    expect(secret.length).toBe(32);
    const before = (await call(t.app, 'GET', '/api/auth/params?username=ghost')).json();
    await t.app.close();

    // Reopen the same data dir: same secret, so the same fake salt.
    const { buildApp } = await import('../src/app.js');
    const reopened = await buildApp({ dataDir: t.dataDir, webDist: path.join(t.dataDir, 'none'), cookieSecure: false });
    const after = (await call(reopened, 'GET', '/api/auth/params?username=ghost')).json();
    expect(after).toEqual(before);
    expect(readFileSync(file).equals(secret)).toBe(true);
    await reopened.close();
    rmSync(t.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    t = undefined;
  });
});

describe('SPA hosting', () => {
  function makeWebDist() {
    const dir = mkdtempSync(path.join(tmpdir(), 'inked-web-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Inked</title><meta name="csp-nonce" content="__CSP_NONCE__">');
    writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    return dir;
  }

  /**
   * CodeMirror injects its own stylesheet at runtime, which `style-src 'self'` blocks outright — the editor
   * then renders with no base theme at all (an unpositioned caret, no selection layer). A per-request nonce
   * lets that one stylesheet through while every other inline style stays blocked.
   */
  describe('style nonce', () => {
    const nonceOf = (csp: string) => /style-src 'self' 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1] ?? null;

    it('puts a nonce in style-src and the same one in the shell it serves', async () => {
      webDist = makeWebDist();
      t = await makeApp({ webDist });

      const res = await t.app.inject({ method: 'GET', url: '/' });
      const nonce = nonceOf(String(res.headers['content-security-policy']));
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,}$/);
      expect(res.body).toContain(`content="${nonce}"`);
      expect(res.body).not.toContain('__CSP_NONCE__');
    });

    it('never repeats a nonce, and never falls back to unsafe-inline', async () => {
      webDist = makeWebDist();
      t = await makeApp({ webDist });

      const seen = new Set<string>();
      for (let i = 0; i < 4; i++) {
        const res = await t.app.inject({ method: 'GET', url: '/' });
        const csp = String(res.headers['content-security-policy']);
        expect(csp).not.toContain('unsafe-inline');
        seen.add(nonceOf(csp)!);
      }
      expect(seen.size).toBe(4);
    });

    it('gives API responses a nonce too, so the header is never stale for a page that reloads', async () => {
      t = await makeApp();
      const res = await t.app.inject({ method: 'GET', url: '/api/status' });
      expect(nonceOf(String(res.headers['content-security-policy']))).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    });
  });

  it('serves files and falls back to index.html for client routes', async () => {
    webDist = makeWebDist();
    t = await makeApp({ webDist });

    const root = await t.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Inked</title>');
    // The shell now carries a per-request nonce, so it must not be cached.
    expect(root.headers['cache-control']).toBe('no-store');
    expect(root.headers).toMatchObject(EXPECTED_HEADERS);

    const deep = await t.app.inject({ method: 'GET', url: '/v/123/n/456' });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    expect(deep.body).toContain('<title>Inked</title>');
    expect(deep.headers['cache-control']).toBe('no-store');
    expect(deep.headers).toMatchObject(EXPECTED_HEADERS);

    const asset = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');
    expect(asset.headers['cache-control']).toContain('immutable');

    const api = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'not_found' });
  });

  it('is API-only when there is no web build', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('diagram frame hosting', () => {
  const FRAME_CSP =
    "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

  function makeFrameDist() {
    const dir = mkdtempSync(path.join(tmpdir(), 'inked-web-'));
    mkdirSync(path.join(dir, 'assets'));
    mkdirSync(path.join(dir, 'frame', 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Inked</title>');
    writeFileSync(path.join(dir, 'frame', 'frame.html'), '<!doctype html><title>Diagram renderer</title>');
    writeFileSync(path.join(dir, 'frame', 'assets', 'frame-abc123.js'), 'console.log(2)');
    return dir;
  }

  it('serves the frame page and its assets with their own CSP and CORS', async () => {
    webDist = makeFrameDist();
    t = await makeApp({ webDist });

    const page = await t.app.inject({ method: 'GET', url: '/frame/frame.html' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Diagram renderer');
    expect(page.headers['content-security-policy']).toBe(FRAME_CSP);
    expect(page.headers['access-control-allow-origin']).toBe('*');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cache-control']).toBe('no-cache');

    const js = await t.app.inject({ method: 'GET', url: '/frame/assets/frame-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-security-policy']).toBe(FRAME_CSP);
    expect(js.headers['access-control-allow-origin']).toBe('*');
    expect(js.headers['cache-control']).toContain('immutable');
  });

  it('leaves the app and the API on the strict CSP with no CORS header', async () => {
    webDist = makeFrameDist();
    t = await makeApp({ webDist });
    for (const url of ['/', '/v/123/n/456', '/assets/none.js', '/api/status', '/api/nope']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.headers).toMatchObject(EXPECTED_HEADERS);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('never answers an unknown /frame path with the SPA shell', async () => {
    webDist = makeFrameDist();
    t = await makeApp({ webDist });
    for (const url of ['/frame', '/frame/', '/frame/nope.html', '/frame/assets/missing.js']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'not_found' });
    }
  });
});

describe('trusted proxy', () => {
  async function hammer(app: TestApp['app'], username: string, xff: string, n: number) {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-inked': '1', 'x-forwarded-for': xff.replace('#', String(i)) },
        payload: { username, authKey: key32() },
      });
      codes.push(r.statusCode);
    }
    return codes;
  }

  for (const [label, trustProxy] of [['one trusted hop', 1], ['a CIDR covering the proxy', '127.0.0.0/8']] as const) {
    it(`with ${label}, the lockout keys on the real client IP, not a forged X-Forwarded-For (I2)`, async () => {
      t = await makeApp({ trustProxy });
      const acct = await setupAdmin(t.app);
      // The proxy appends the real client (always 203.0.113.9) after the forged value.
      const codes = await hammer(t.app, acct.username, '198.51.100.#, 203.0.113.9', 8);
      expect(codes.slice(5)).toEqual([429, 429, 429]);
      // A different real client is not locked out by that.
      const other = await hammer(t.app, acct.username, '198.51.100.1, 203.0.113.10', 1);
      expect(other).toEqual([401]);
    });
  }

  it('with a hop count of 2, keys on the second-to-last X-Forwarded-For entry (C1)', async () => {
    t = await makeApp({ trustProxy: 2 });
    const acct = await setupAdmin(t.app);
    const codes = await hammer(t.app, acct.username, '198.51.100.#, 203.0.113.50, 203.0.113.9', 8);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    // A different second-to-last entry is a different client, even with the same last entry.
    expect(await hammer(t.app, acct.username, '198.51.100.1, 203.0.113.51, 203.0.113.9', 1)).toEqual([401]);
  });
});

describe('LLM origins', () => {
  it('adds the origins to connect-src and /api/status', async () => {
    const t = await makeApp({ llmOrigins: ['https://api.openai.com'] });
    try {
      const r = await call(t.app, 'GET', '/api/status', {});
      expect(r.json()).toEqual({ needsSetup: true, llmOrigins: ['https://api.openai.com'] });
      expect(r.headers['content-security-policy']).toContain("connect-src 'self' https://api.openai.com;");
    } finally {
      await t.close();
    }
  });
  it('keeps connect-src self-only by default', async () => {
    const t = await makeApp();
    try {
      const r = await call(t.app, 'GET', '/api/status', {});
      expect(r.json().llmOrigins).toEqual([]);
      expect(r.headers['content-security-policy']).toContain("connect-src 'self';");
    } finally {
      await t.close();
    }
  });
});

