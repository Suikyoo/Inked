import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

let t: TestApp;
let webDist: string;

async function setup(files: Record<string, string>) {
  webDist = mkdtempSync(path.join(tmpdir(), 'inked-web-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(webDist, name), body);
  mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  t = await makeApp({ webDist });
}

afterEach(async () => {
  await t.close();
  rmSync(webDist, { recursive: true, force: true });
});

describe('openboard entry pages', () => {
  beforeEach(async () => {
    await setup({ 'index.html': 'main', 'openboard.html': 'visitor', 'openboard-editor.html': 'editor' });
  });

  it('serves the visitor page under /ob/', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/ob/some-token?x=1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('visitor');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });

  it('serves the editor page under /openboard', async () => {
    for (const url of ['/openboard', '/openboard/links', '/openboard?a=b']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.body).toContain('editor');
    }
  });

  it('falls back to index.html otherwise and does not match lookalike prefixes', async () => {
    for (const url of ['/v/x', '/openboardx', '/obx/y']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.body).toContain('main');
    }
  });

  it('keeps /api and /frame as JSON 404s', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/ob/zzz' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('visitor');
    expect(res.json()).toEqual({ error: 'not_found' });
    expect((await t.app.inject({ method: 'GET', url: '/frame/nope' })).statusCode).toBe(404);
  });

  it('does not serve pages for non-GET methods', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/ob/x', headers: { 'x-inked': '1' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('without the openboard pages built', () => {
  it('falls back to index.html', async () => {
    await setup({ 'index.html': 'main' });
    const res = await t.app.inject({ method: 'GET', url: '/ob/x' });
    expect(res.body).toContain('main');
  });
});
