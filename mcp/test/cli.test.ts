import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../src/cli';
import { fakeBrowser, submitPage } from './helpers/page';
import { addVault, changePassword, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

function fakeIO(answers: string[], password: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ask: async () => answers.shift() ?? '',
    askHidden: async () => password,
  };
  return { io, out, err };
}

describe('inked-mcp CLI', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let home: string;
  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    await addVault(srv.baseUrl, 'jude', PW, 'Work');
  });
  afterAll(() => srv.close());
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'inked-cli-'));
    process.env.INKED_MCP_HOME = home;
  });

  it('login saves a credential without the password; status prints the resolved policy', async () => {
    const a = fakeIO([srv.baseUrl, 'jude'], PW);
    expect(await main(['login'], a.io)).toBe(0);
    const saved = readFileSync(path.join(home, 'credential.json'), 'utf8');
    expect(saved).not.toContain(PW);
    const s = fakeIO([], '');
    expect(await main(['status'], s.io)).toBe(0);
    const text = s.out.join('\n');
    expect(text).toContain(`Signed in as jude at ${srv.baseUrl}`);
    expect(text).toContain('Vaults: all (*)');
    expect(text).toContain('Actions: config.change, note.read, search, tree.read, vault.list');
    expect(text).toContain('Writes per minute: 120');
  });

  it('login reports a wrong password without saving', async () => {
    const a = fakeIO([srv.baseUrl, 'jude'], 'not the password');
    expect(await main(['login'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('Wrong username or password.');
    expect(existsSync(path.join(home, 'credential.json'))).toBe(false);
  });

  it('status stops with a clear error on a bad config; serve keeps running so the AI can fix it', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, vaults: ['Nope'], actions: ['@read'] }));
    const s = fakeIO([], '');
    expect(await main(['status'], s.io)).toBe(1);
    expect(s.err.join('\n')).toContain('Vault "Nope" not found');
    const v = fakeIO([], '');
    expect(await main(['serve'], v.io, { connect: async () => undefined })).toBe(0);
    expect(v.err.join('\n')).toContain('tools: inked_status, sign_out, change_config');
  });

  it('serve starts signed out after a password change, with a plain reason', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    await changePassword(srv.baseUrl, 'jude', PW, 'another password here');
    try {
      const v = fakeIO([], '');
      expect(await main(['serve'], v.io, { connect: async () => undefined })).toBe(0);
      expect(v.err.join('\n')).toContain('signed out (Your Inked password changed');
      expect(v.err.join('\n')).toContain('tools: inked_status, sign_in');
    } finally {
      await changePassword(srv.baseUrl, 'jude', 'another password here', PW);
    }
  });

  it('serve starts signed out when there is no credential', async () => {
    const v = fakeIO([], '');
    expect(await main(['serve'], v.io, { connect: async () => undefined })).toBe(0);
    expect(v.err.join('\n')).toContain('signed out; tools: inked_status, sign_in');
  });

  it('config opens the settings page and saves what the user applies', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    const browser = fakeBrowser();
    const c = fakeIO([], '');
    const pending = main(['config'], c.io, { openBrowser: browser.open });
    const url = await browser.next();
    await submitPage(url, { all: 'on', action: ['vault.list', 'tree.read', 'note.read', 'search'], wpm: '120' });
    expect(await pending).toBe(0);
    expect(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'))).toEqual({
      version: 1, vaults: '*', actions: ['@read'], limits: { writesPerMinute: 120 },
    });
    expect(c.out.join('\n')).toContain(url);
  });

  it('config without a credential says to log in', async () => {
    const c = fakeIO([], '');
    expect(await main(['config'], c.io)).toBe(1);
    expect(c.err.join('\n')).toContain('inked-mcp login');
  });

  it('config with the server unreachable gives the reason only', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const c = fakeIO([], '');
    expect(await main(['config'], c.io, { fetch: down })).toBe(1);
    expect(c.err).toEqual(['Can’t reach the Inked server.']);
  });

  it('config tells the user when a running AI client picks up the change', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    const browser = fakeBrowser();
    const c = fakeIO([], '');
    const pending = main(['config'], c.io, { openBrowser: browser.open });
    await submitPage(await browser.next(), { all: 'on', action: ['vault.list'], wpm: '120' });
    expect(await pending).toBe(0);
    expect(c.out).toContain('Saved. A running AI client picks this up at its next status check, or reconnect inked in /mcp.');
  });

  it('status after a password change tells the user to log in again', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    await changePassword(srv.baseUrl, 'jude', PW, 'another password here');
    try {
      const s = fakeIO([], '');
      expect(await main(['status'], s.io)).toBe(1);
      expect(s.err.join('\n')).toContain('Run `inked-mcp login`');
    } finally {
      await changePassword(srv.baseUrl, 'jude', 'another password here', PW);
    }
  });

  it('serve closes the session and exits 1 when connect throws', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    const logouts: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/auth/logout')) logouts.push(url);
      return fetch(input, init);
    };
    const v = fakeIO([], '');
    const code = await main(['serve'], v.io, {
      fetch: spy,
      connect: async () => {
        throw new Error('transport boom');
      },
    });
    expect(code).toBe(1);
    expect(v.err.join('\n')).toContain('transport boom');
    expect(logouts.length).toBe(1);
  });

  it('logout deletes the credential and explains revocation', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    const l = fakeIO([], '');
    expect(await main(['logout'], l.io)).toBe(0);
    expect(existsSync(path.join(home, 'credential.json'))).toBe(false);
    expect(l.out.join('\n')).toContain('change your Inked password');
  });

  it('login refuses plain http to a public host with a readable message', async () => {
    const a = fakeIO(['http://notes.example.com', 'jude'], PW);
    expect(await main(['login'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('must use https://');
  });

  it('prints usage for an unknown command', async () => {
    const u = fakeIO([], '');
    expect(await main(['frobnicate'], u.io)).toBe(2);
    expect(u.err.join('\n')).toContain('Usage: inked-mcp');
  });
});
