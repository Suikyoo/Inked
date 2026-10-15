import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptImage } from 'inked-core';
import { type ImageSource, Ops } from '../src/ops';
import { TOOL_NAMES } from '../src/tools';
import { parseConfig, resolvePolicy } from '../src/policy';
import { createCredential, Session } from '../src/session';
import { listAllVaults, VaultModel } from '../src/vault-model';
import { addVault, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';
const MARKER = 'SECRET-PIXELS-MARKER';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(MARKER)]);

describe('add_image', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let session: Session;

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    await addVault(srv.baseUrl, 'jude', PW, 'Work');
    session = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await session.start();
  });
  afterAll(async () => {
    await session.close();
    await srv.close();
  });

  const build = async (actions: string[], imageSource?: ImageSource, imageDirs: string[] = []) => {
    const policy = resolvePolicy(parseConfig({ version: 1, vaults: '*', actions, imageDirs }), await listAllVaults(session));
    const model = new VaultModel(session, policy);
    return { o: new Ops(session, model, policy, undefined, imageSource), model };
  };
  const rows = () => {
    const db = new DatabaseSync(path.join(srv.dataDir, 'inked.db'), { readOnly: true });
    try {
      return db.prepare('SELECT id, vault_id, size, enc_blob FROM images').all() as { id: string; vault_id: string; size: number; enc_blob: Uint8Array }[];
    } finally {
      db.close();
    }
  };
  const fetchUrl = (bytes: Uint8Array) => vi.fn(async () => bytes);
  const never = async () => {
    throw new Error('unused');
  };

  it('is a registered tool', () => {
    expect(TOOL_NAMES).toContain('add_image');
  });

  it('uploads only ciphertext that the vault key decrypts, and returns the markdown token', async () => {
    const { o, model } = await build(['@read', 'image.create'], { fetchUrl: fetchUrl(PNG), readFile: never });
    const out = await o.addImage('Work', { url: 'https://img.test/a.png' }, 'a [diagram]');
    expect(out.markdown).toBe(`![a diagram](inked://${out.id})`);
    expect(out.size).toBe(PNG.length);
    const row = rows().find((r) => r.id === out.id)!;
    const blob = Buffer.from(row.enc_blob);
    expect(blob.includes(Buffer.from(MARKER))).toBe(false);
    expect(row.size).toBe(PNG.length + 28);
    const snap = await model.snapshot(out.vaultId);
    expect(await decryptImage(snap.key, out.vaultId, out.id, new Uint8Array(blob))).toEqual(PNG);
  });

  it('refuses without the image.create action', async () => {
    const { o } = await build(['@read', '@write'], { fetchUrl: fetchUrl(PNG), readFile: never });
    await expect(o.addImage('Work', { url: 'https://img.test/a.png' })).rejects.toMatchObject({ kind: 'denied' });
  });

  it('needs exactly one source', async () => {
    const { o } = await build(['@read', 'image.create'], { fetchUrl: fetchUrl(PNG), readFile: never });
    await expect(o.addImage('Work', {})).rejects.toMatchObject({ kind: 'invalid' });
    await expect(o.addImage('Work', { url: 'https://a.test/x', path: '/x' })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses bytes that are not an allowed image (an SVG renamed .png) and uploads nothing', async () => {
    const before = rows().length;
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const { o } = await build(['@read', 'image.create'], { fetchUrl: fetchUrl(svg), readFile: async () => svg });
    await expect(o.addImage('Work', { url: 'https://img.test/a.png' })).rejects.toMatchObject({ kind: 'invalid' });
    await expect(o.addImage('Work', { path: '/pics/a.png' })).rejects.toMatchObject({ kind: 'invalid' });
    expect(rows().length).toBe(before);
  });

  it('reads a local path through the policy image folders', async () => {
    const dir = path.resolve('pics');
    const readFile = vi.fn(async () => PNG);
    const { o } = await build(['@read', 'image.create'], { fetchUrl: never, readFile }, [dir]);
    const out = await o.addImage('Work', { path: path.join(dir, 'a.png') });
    expect(readFile).toHaveBeenCalledWith(path.join(dir, 'a.png'), [dir]);
    expect(out.markdown).toBe(`![](inked://${out.id})`);
  });

  it('keeps local files off when no image folder is configured', async () => {
    const { o } = await build(['@read', 'image.create']); // real image sources
    await expect(o.addImage('Work', { path: path.resolve('pics', 'a.png') })).rejects.toMatchObject({ kind: 'denied' });
  });

  it('reports an unknown vault like a missing one', async () => {
    const { o } = await build(['@read', 'image.create'], { fetchUrl: fetchUrl(PNG), readFile: never });
    await expect(o.addImage('Nope', { url: 'https://img.test/a.png' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});
