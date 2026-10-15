import { promises as fs } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { MAX_IMAGE_BYTES } from 'inked-core';
import { ToolError } from './errors';

const MAX_HOPS = 3;
const TIMEOUT_MS = 15_000;
const TOO_BIG = 'The image is larger than 10 MB.';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** Throws unless `address` is a public internet address (IPv4-mapped IPv6 is checked as IPv4). */
export function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new ToolError('invalid', 'That address is not a public internet address.');
  }
}

export interface HopResult {
  status: number;
  location: string | null;
  body: Uint8Array | null;
}

export interface FetchDeps {
  /** Every address a name resolves to. */
  lookup(host: string): Promise<string[]>;
  /** One request to `url`, connected to `address` (never re-resolved). No redirect is followed. */
  hop(url: URL, address: string, family: 4 | 6): Promise<HopResult>;
}

const bare = (hostname: string) => (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname);

function httpsHop(url: URL, address: string, family: 4 | 6): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const host = bare(url.hostname);
    const req = httpsRequest(
      {
        host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        servername: isIP(host) ? undefined : host,
        headers: { 'user-agent': 'inked-mcp', accept: 'image/png,image/jpeg,image/gif,image/webp' },
        // Pin the connection to the address that was validated.
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          o?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location ?? null, body: null });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_IMAGE_BYTES) {
            req.destroy();
            reject(new ToolError('invalid', TOO_BIG));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, location: null, body: new Uint8Array(Buffer.concat(chunks)) }));
        res.on('error', () => reject(new ToolError('invalid', 'The download failed.')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(new ToolError('invalid', 'Could not download that image.')));
    req.end();
  });
}

const defaultDeps: FetchDeps = {
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address),
  hop: httpsHop,
};

function parseHttps(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError('invalid', 'Not a valid URL.');
  }
  if (u.protocol !== 'https:') throw new ToolError('invalid', 'Only https:// image links are supported.');
  if (u.username || u.password) throw new ToolError('invalid', 'Links with a username or password are not supported.');
  return u;
}

/**
 * Downloads an image from a public https URL. Every address a name resolves to must be public, the
 * connection goes to the address that was checked, and each redirect hop is checked again (at most 3).
 */
export async function fetchImageUrl(raw: string, deps: FetchDeps = defaultDeps): Promise<Uint8Array> {
  let url = parseHttps(raw);
  for (let hops = 0; ; hops++) {
    const host = bare(url.hostname);
    let addresses: string[];
    if (isIP(host)) addresses = [host];
    else {
      try {
        addresses = await deps.lookup(host);
      } catch {
        throw new ToolError('invalid', 'Could not look up that host.');
      }
    }
    if (addresses.length === 0) throw new ToolError('invalid', 'Could not look up that host.');
    for (const a of addresses) assertPublicAddress(a);
    const res = await deps.hop(url, addresses[0], isIP(addresses[0]) as 4 | 6);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hops >= MAX_HOPS) throw new ToolError('invalid', 'Too many redirects.');
      if (!res.location) throw new ToolError('invalid', 'The link redirects nowhere.');
      let next: string;
      try {
        next = new URL(res.location, url).toString();
      } catch {
        throw new ToolError('invalid', 'The link redirects to an invalid address.');
      }
      url = parseHttps(next);
      continue;
    }
    if (res.status !== 200 || !res.body) throw new ToolError('invalid', `The server answered ${res.status}.`);
    if (res.body.length > MAX_IMAGE_BYTES) throw new ToolError('invalid', TOO_BIG);
    return res.body;
  }
}

const inside = (dir: string, file: string) => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Reads a local image file, only from inside a folder in `dirs` (symlinks resolved first). */
export async function readImageFile(file: string, dirs: readonly string[]): Promise<Uint8Array> {
  if (dirs.length === 0) {
    throw new ToolError('denied', 'Local files are off. List folders as "imageDirs" in the Inked MCP config file to allow them.');
  }
  let real: string;
  try {
    real = await fs.realpath(file);
  } catch {
    throw new ToolError('not_found', 'File not found.');
  }
  let allowed = false;
  for (const dir of dirs) {
    const realDir = await fs.realpath(dir).catch(() => null);
    if (realDir && inside(realDir, real)) allowed = true;
  }
  if (!allowed) throw new ToolError('denied', 'That file is not inside a folder listed in "imageDirs".');
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new ToolError('invalid', 'That is not a file.');
  if (stat.size > MAX_IMAGE_BYTES) throw new ToolError('invalid', TOO_BIG);
  return new Uint8Array(await fs.readFile(real));
}
