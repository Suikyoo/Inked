import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ops } from '../src/ops';
import { parseConfig, resolvePolicy } from '../src/policy';
import { createCredential, Session } from '../src/session';
import { listAllVaults, VaultModel } from '../src/vault-model';
import { seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

describe('Ops.createVault', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let session: Session;

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    session = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await session.start();
  });
  afterAll(async () => {
    await session.close();
    await srv.close();
  });

  async function opsWith(actions: string[], writesPerMinute = 120) {
    const policy = resolvePolicy(parseConfig({ version: 1, vaults: '*', actions, limits: { writesPerMinute } }), await listAllVaults(session));
    return new Ops(session, new VaultModel(session, policy), policy);
  }

  it('creates a vault that decrypts with its name and color', async () => {
    const ops = await opsWith(['@read', '@manage']);
    const made = await ops.createVault('  Research  ', '#6F95D6');
    expect(made).toMatchObject({ name: 'Research', color: '#6F95D6' });
    const listed = (await listAllVaults(session)).find((v) => v.id === made.id);
    expect(listed).toMatchObject({ name: 'Research', color: '#6F95D6' });
    expect(listed?.broken).toBeUndefined();
  });

  it('needs vault.create', async () => {
    const ops = await opsWith(['@read']);
    await expect(ops.createVault('X', '#45A89E')).rejects.toThrow('Not permitted by the Inked MCP config: vault.create.');
  });

  it('refuses an empty name and a color outside the palette', async () => {
    const ops = await opsWith(['@manage']);
    await expect(ops.createVault('   ', '#45A89E')).rejects.toThrow('Vault name must not be empty.');
    await expect(ops.createVault('X', '#000000')).rejects.toThrow('Color must be one of');
  });

  it('counts against the write limit', async () => {
    const ops = await opsWith(['@manage'], 1);
    await ops.createVault('One', '#45A89E');
    await expect(ops.createVault('Two', '#45A89E')).rejects.toThrow('Write limit reached');
  });
});
