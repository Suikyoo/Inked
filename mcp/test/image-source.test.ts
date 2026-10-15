import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from 'inked-core';
import { ToolError } from '../src/errors';
import { armDeadline, assertPublicAddress, fetchImageUrl, readImageFile, type FetchDeps, type HopResult } from '../src/image-source';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ok = (body: Uint8Array): HopResult => ({ status: 200, location: null, body });
const redirect = (to: string, status = 302): HopResult => ({ status, location: to, body: null });
const deps = (hosts: Record<string, string[]>, hop: FetchDeps['hop']): FetchDeps => ({
  lookup: async (h) => {
    const a = hosts[h];
    if (!a) throw new Error('ENOTFOUND');
    return a;
  },
  hop,
});

describe('assertPublicAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
  ])('refuses %s', (a) => {
    expect(() => assertPublicAddress(a)).toThrow(ToolError);
  });
  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (a) => {
    expect(() => assertPublicAddress(a)).not.toThrow();
  });
  it('refuses something that is not an address', () => {
    expect(() => assertPublicAddress('example.com')).toThrow(ToolError);
  });
});

describe('fetchImageUrl', () => {
  it.each([
    'http://example.com/a.png',
    'ftp://example.com/a.png',
    'file:///etc/passwd',
    'https://user:pw@example.com/a.png',
    'not a url',
  ])('refuses %s without any request', async (u) => {
    const hop = vi.fn();
    await expect(fetchImageUrl(u, deps({ 'example.com': ['93.184.216.34'] }, hop))).rejects.toThrow(ToolError);
    expect(hop).not.toHaveBeenCalled();
  });
  it.each([
    'https://127.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://10.0.0.1/a.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:7f00:1]/a.png',
    'https://192.168.1.1/a.png',
  ])('refuses the private literal %s without any request', async (u) => {
    const hop = vi.fn();
    await expect(fetchImageUrl(u, deps({}, hop))).rejects.toThrow(/public/);
    expect(hop).not.toHaveBeenCalled();
  });
  it('refuses a name that resolves to a private address, even if another answer is public', async () => {
    const hop = vi.fn();
    const d = deps({ 'evil.test': ['93.184.216.34', '10.0.0.5'], 'internal.test': ['192.168.0.9'] }, hop);
    await expect(fetchImageUrl('https://evil.test/a.png', d)).rejects.toThrow(/public/);
    await expect(fetchImageUrl('https://internal.test/a.png', d)).rejects.toThrow(/public/);
    expect(hop).not.toHaveBeenCalled();
  });
  it('refuses a name that does not resolve', async () => {
    await expect(fetchImageUrl('https://nx.test/a.png', deps({}, vi.fn()))).rejects.toThrow(ToolError);
  });
  it('connects to the address it validated and returns the body', async () => {
    const hop = vi.fn(async () => ok(PNG));
    const out = await fetchImageUrl('https://img.test/a.png', deps({ 'img.test': ['93.184.216.34'] }, hop));
    expect(out).toEqual(PNG);
    expect(hop).toHaveBeenCalledWith(expect.any(URL), '93.184.216.34', 4);
  });
  it('follows a redirect to another public host, validating it too', async () => {
    const hop = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://cdn.test/x.png'))
      .mockResolvedValueOnce(ok(PNG));
    const out = await fetchImageUrl('https://a.test/a', deps({ 'a.test': ['93.184.216.34'], 'cdn.test': ['8.8.8.8'] }, hop));
    expect(out).toEqual(PNG);
    expect(hop.mock.calls[1][1]).toBe('8.8.8.8');
  });
  it.each(['https://169.254.169.254/latest', 'https://localhost.test/x', 'http://example.com/x'])(
    'refuses a redirect to %s',
    async (to) => {
      const hop = vi.fn().mockResolvedValueOnce(redirect(to));
      const d = deps({ 'a.test': ['93.184.216.34'], 'localhost.test': ['127.0.0.1'] }, hop);
      await expect(fetchImageUrl('https://a.test/a', d)).rejects.toThrow(ToolError);
      expect(hop).toHaveBeenCalledTimes(1);
    },
  );
  it('gives up after 3 redirects', async () => {
    const hop = vi.fn(async () => redirect('https://a.test/again'));
    await expect(fetchImageUrl('https://a.test/a', deps({ 'a.test': ['93.184.216.34'] }, hop))).rejects.toThrow(/redirect/i);
    expect(hop).toHaveBeenCalledTimes(4);
  });
  it('refuses a redirect with no location and a non-200 answer', async () => {
    const d = (r: HopResult) => deps({ 'a.test': ['93.184.216.34'] }, async () => r);
    await expect(fetchImageUrl('https://a.test/a', d({ status: 302, location: null, body: null }))).rejects.toThrow(ToolError);
    await expect(fetchImageUrl('https://a.test/a', d({ status: 404, location: null, body: null }))).rejects.toThrow(/404/);
  });
});

describe('readImageFile', () => {
  let root: string;
  let allowed: string;
  let outside: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'inked-img-'));
    allowed = path.join(root, 'allowed');
    outside = path.join(root, 'outside');
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(path.join(allowed, 'a.png'), PNG);
    writeFileSync(path.join(outside, 'b.png'), PNG);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reads a file inside an allowed folder', async () => {
    expect(await readImageFile(path.join(allowed, 'a.png'), [allowed])).toEqual(PNG);
  });
  it('is off when no folder is listed', async () => {
    await expect(readImageFile(path.join(allowed, 'a.png'), [])).rejects.toMatchObject({ kind: 'denied' });
  });
  it('refuses a file outside the allowed folders, including by ..', async () => {
    await expect(readImageFile(path.join(outside, 'b.png'), [allowed])).rejects.toMatchObject({ kind: 'denied' });
    await expect(readImageFile(path.join(allowed, '..', 'outside', 'b.png'), [allowed])).rejects.toMatchObject({ kind: 'denied' });
  });
  it('refuses a symlink that points outside', async () => {
    const link = path.join(allowed, 'link.png');
    try {
      symlinkSync(path.join(outside, 'b.png'), link);
    } catch {
      return; // creating symlinks needs a privilege on some Windows setups
    }
    await expect(readImageFile(link, [allowed])).rejects.toMatchObject({ kind: 'denied' });
  });
  it('reports a missing file without echoing the path', async () => {
    const e = await readImageFile(path.join(allowed, 'nope.png'), [allowed]).catch((x) => x);
    expect(e).toMatchObject({ kind: 'not_found' });
    expect(String(e.message)).not.toContain(allowed);
  });
  it('answers the same denied for a missing file outside the allowed folders', async () => {
    const e = await readImageFile(path.join(outside, 'nope.png'), [allowed]).catch((x) => x);
    expect(e).toMatchObject({ kind: 'denied' });
    expect(String(e.message)).not.toContain(outside);
  });
  it('refuses a file over 10 MiB', async () => {
    const big = path.join(allowed, 'big.png');
    writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1, 1));
    await expect(readImageFile(big, [allowed])).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('armDeadline', () => {
  it('fires after the delay, and not once disarmed', () => {
    vi.useFakeTimers();
    try {
      const a = vi.fn();
      const b = vi.fn();
      armDeadline(1000, a);
      armDeadline(1000, b)();
      vi.advanceTimersByTime(1000);
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
