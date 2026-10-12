import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalServer } from '../src/approval';
import { Audit } from '../src/audit';
import { saveCredential } from '../src/credential';
import { Flows } from '../src/flows';
import { Runtime } from '../src/runtime';
import { createCredential } from '../src/session';
import { listAllVaults } from '../src/vault-model';
import { addVault, seedUser, startInked } from './helpers/inked';
import { fakeBrowser, loadPage, submitPage } from './helpers/page';

const PW = 'correct horse battery';

describe('Flows', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let home: string;
  let workId: string;
  let adaWorkId: string;
  const runtimes: Runtime[] = [];

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    workId = await addVault(srv.baseUrl, 'jude', PW, 'Work');
    await seedUser(srv.baseUrl, 'ada', PW);
    adaWorkId = await addVault(srv.baseUrl, 'ada', PW, 'Work');
  });
  afterAll(() => srv.close());
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'inked-flows-'));
    process.env.INKED_MCP_HOME = home;
  });
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.close()));
  });

  async function setup(
    o: { user?: string; signedIn?: boolean; config?: unknown; browserOk?: boolean; timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {
    if (o.signedIn ?? true) {
      saveCredential(await createCredential({ baseUrl: srv.baseUrl, username: o.user ?? 'jude', password: PW }));
    }
    if (o.config) writeFileSync(path.join(home, 'config.json'), JSON.stringify(o.config));
    const runtime = new Runtime({ fetch: o.fetch });
    await runtime.start();
    runtimes.push(runtime);
    const browser = fakeBrowser(o.browserOk ?? true);
    const approvals = new ApprovalServer({ openBrowser: browser.open, timeoutMs: o.timeoutMs });
    const flows = new Flows(runtime, approvals, new Audit(path.join(home, 'audit.log')), { fetch: o.fetch });
    return { runtime, flows, browser };
  }
  const configOnDisk = () => JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
  const good = () => ({ baseUrl: srv.baseUrl, username: 'jude', password: PW });

  it('sign-in: a wrong password stays on the page, the right one signs in, and the password is kept nowhere', async () => {
    const { runtime, flows, browser } = await setup({ signedIn: false });
    const pending = flows.signIn();
    const url = await browser.next();
    const bad = await submitPage(url, { baseUrl: srv.baseUrl, username: 'jude', password: 'wrong password!!' });
    expect(bad.html).toContain('Wrong username or password.');
    expect(bad.html).not.toContain('wrong password!!');
    await submitPage(url, good());
    const r = await pending;
    expect(r).toMatchObject({ outcome: 'signed_in', user: 'jude', server: srv.baseUrl });
    expect(JSON.stringify(r)).not.toContain(PW);
    expect(runtime.state.kind).toBe('ready');
    expect(readFileSync(path.join(home, 'credential.json'), 'utf8')).not.toContain(PW);
    expect(readFileSync(path.join(home, 'audit.log'), 'utf8')).not.toContain(PW);
  });

  it('sign-in returns open_link when no browser starts, and the page still works', async () => {
    const { runtime, flows } = await setup({ signedIn: false, browserOk: false });
    const r = await flows.signIn();
    expect(r).toMatchObject({ outcome: 'open_link' });
    await submitPage((r as { url: string }).url, good());
    expect(runtime.state.kind).toBe('ready');
  });

  it('sign-in reports cancel and timeout', async () => {
    const a = await setup({ signedIn: false });
    const pending = a.flows.signIn();
    await submitPage(await a.browser.next(), {}, 'cancel');
    expect(await pending).toEqual({ outcome: 'cancelled' });
    const b = await setup({ signedIn: false, timeoutMs: 50 });
    expect(await b.flows.signIn()).toEqual({ outcome: 'timed_out' });
  });

  it('status explains each state in plain words, without paths', async () => {
    const out = await setup({ signedIn: false });
    expect(await out.flows.status()).toEqual({ signedIn: false, next: expect.any(String) });

    const ready = await setup();
    const st = await ready.flows.status();
    expect(st).toMatchObject({
      signedIn: true,
      user: 'jude',
      vaults: 'all',
      actions: ['config.change', 'note.read', 'search', 'tree.read', 'vault.list'],
    });
    expect(st).not.toHaveProperty('settings');

    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, vaults: ['Nope'], actions: ['@read'] }));
    await ready.runtime.reload();
    const broken = await ready.flows.status();
    expect(broken).toMatchObject({ signedIn: true, problem: expect.stringContaining('Use change_config') });
    expect(JSON.stringify(broken)).not.toContain(home.replace(/\\/g, '\\\\'));

    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, vaults: '*', actions: ['@read'] }));
    await ready.runtime.reload();
    expect(await ready.flows.status()).toMatchObject({ settings: expect.stringContaining('inked-mcp config') });
  });

  it('status retries a server that was unreachable at start, without a new sign-in', async () => {
    let down = true;
    const flaky: typeof fetch = (input, init) => (down ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init));
    const { flows } = await setup({ fetch: flaky });
    expect(await flows.status()).toMatchObject({ signedIn: false, problem: 'Can’t reach the Inked server.' });
    down = false;
    expect(await flows.status()).toMatchObject({ signedIn: true, user: 'jude' });
  });

  it('change_config marks the proposal; Apply writes what the user picked and reloads', async () => {
    const { runtime, flows, browser } = await setup();
    const pending = flows.changeConfig({ actions: ['@read', '@write', 'config.change'] });
    const url = await browser.next();
    const { html } = await loadPage(url);
    expect(html.match(/proposed by Claude/g)).toHaveLength(4);
    await submitPage(url, {
      all: 'on',
      action: ['vault.list', 'tree.read', 'note.read', 'search', 'note.create', 'config.change'],
      wpm: '60',
    });
    expect(await pending).toMatchObject({ outcome: 'config_applied', vaults: 'all', writesPerMinute: 60 });
    expect(configOnDisk()).toEqual({
      version: 1,
      vaults: '*',
      actions: ['@read', 'note.create', 'config.change'],
      limits: { writesPerMinute: 60 },
    });
    expect(runtime.state.kind === 'ready' && runtime.state.policy.actions.has('note.create')).toBe(true);
  });

  it('change_config refuses an invalid proposal without opening a page', async () => {
    const { flows, browser } = await setup();
    await expect(flows.changeConfig({ vaults: ['Nope'] })).rejects.toThrow('Vault "Nope" not found. Nothing was opened.');
    expect(browser.calls).toBe(0);
  });

  it('change_config is denied without config.change, unless the user runs it', async () => {
    const { flows, browser } = await setup({ config: { version: 1, vaults: '*', actions: ['@read'] } });
    await expect(flows.changeConfig()).rejects.toThrow('config.change');
    const pending = flows.changeConfig({}, { byUser: true });
    await submitPage(await browser.next(), {}, 'cancel');
    expect(await pending).toEqual({ outcome: 'cancelled' });
  });

  it('change_config repairs a broken config', async () => {
    const { runtime, flows, browser } = await setup({ config: { version: 1, vaults: ['Nope'], actions: ['@read'] } });
    expect(runtime.state.kind).toBe('config-error');
    const pending = flows.changeConfig();
    const url = await browser.next();
    expect((await loadPage(url)).html).toContain('The current settings are invalid: Vault &quot;Nope&quot; not found.');
    await submitPage(url, { vault: workId, action: ['vault.list'], wpm: '120' });
    expect(await pending).toMatchObject({ outcome: 'config_applied' });
    expect(runtime.state.kind).toBe('ready');
    expect(configOnDisk().vaults).toEqual(['Work']);
  });

  it('create_vault: Cancel creates nothing; Create makes it and grants it, switching shared names to ids', async () => {
    const { runtime, flows, browser } = await setup({ user: 'ada', config: { version: 1, vaults: ['Work'], actions: ['@read', '@manage'] } });
    let pending: Promise<unknown> = flows.createVault('Never made');
    await submitPage(await browser.next(), {}, 'cancel');
    expect(await pending).toEqual({ outcome: 'cancelled' });
    expect((await listAllVaults(runtime.session())).some((v) => v.name === 'Never made')).toBe(false);

    pending = flows.createVault('Work');
    await submitPage(await browser.next(), { name: 'Work', color: '#D9768F' });
    const r = (await pending) as { outcome: string; vault: { id: string; name: string; color: string } };
    expect(r).toMatchObject({ outcome: 'vault_created', vault: { name: 'Work', color: '#D9768F' } });
    expect(configOnDisk().vaults).toEqual([adaWorkId, r.vault.id]);
    expect(runtime.state.kind === 'ready' && runtime.state.policy.vaultAllowed(r.vault.id)).toBe(true);
  });

  it('create_vault leaves a "*" config alone', async () => {
    const config = { version: 1, vaults: '*', actions: ['@read', '@manage'] };
    const { flows, browser } = await setup({ config });
    const pending = flows.createVault('Fresh');
    await submitPage(await browser.next(), { name: 'Fresh', color: '#45A89E' });
    expect(await pending).toMatchObject({ outcome: 'vault_created' });
    expect(configOnDisk()).toEqual(config);
  });

  it('create_vault needs vault.create', async () => {
    const { flows } = await setup();
    await expect(flows.createVault('X')).rejects.toThrow('vault.create');
  });
});
