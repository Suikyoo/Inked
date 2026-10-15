import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApprovalServer } from '../src/approval';
import { Audit } from '../src/audit';
import { saveCredential, type Credential } from '../src/credential';
import { ApiError, CredentialStale } from '../src/errors';
import { Flows } from '../src/flows';
import { Runtime } from '../src/runtime';
import { createCredential, type Session } from '../src/session';
import { buildInstructions, createInkedServer, TOOL_NAMES } from '../src/tools';
import { addVault, seedUser, startInked } from './helpers/inked';
import { fakeBrowser, submitPage } from './helpers/page';

const PW = 'correct horse battery';
const cfg = (actions: string[]) => ({ version: 1, vaults: '*', actions });
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0].text);

describe('MCP tools', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let cred: Credential;
  let auditFile = '';
  const runtimes: Runtime[] = [];

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    await addVault(srv.baseUrl, 'jude', PW, 'Work');
    cred = await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW });
  });
  afterAll(() => srv.close());
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.close()));
  });

  /** A server over an in-memory transport. `config: null` means no config file. */
  async function connect(config: unknown | null, opts: { signedIn?: boolean } = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'inked-tools-'));
    process.env.INKED_MCP_HOME = home;
    if (opts.signedIn ?? true) saveCredential(cred);
    if (config) writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    const runtime = new Runtime();
    await runtime.start();
    runtimes.push(runtime);
    const browser = fakeBrowser();
    auditFile = path.join(home, 'audit.log');
    const audit = new Audit(auditFile);
    const flows = new Flows(runtime, new ApprovalServer({ openBrowser: browser.open }), audit);
    const { server, registered } = createInkedServer({ runtime, flows, audit, version: 'test' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, runtime, browser, registered };
  }
  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
  const auditLines = () => readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('lists only what the state allows, and never a delete tool', async () => {
    expect(await names((await connect(null, { signedIn: false })).client)).toEqual(['inked_status', 'sign_in']);
    expect(await names((await connect(cfg(['@read']))).client)).toEqual(
      ['get_tree', 'inked_status', 'list_vaults', 'read_note', 'search', 'sign_out'],
    );
    expect(await names((await connect(null)).client)).toContain('change_config');
    const everything = await names((await connect(cfg(['@read', '@write', '@organize', '@manage', 'image.create', 'config.change']))).client);
    expect(everything).toEqual(TOOL_NAMES.filter((n) => n !== 'sign_in').sort());
    expect(await names((await connect({ version: 1, vaults: ['Nope'], actions: ['@read'] })).client)).toEqual(
      ['change_config', 'inked_status', 'sign_out'],
    );
    expect(TOOL_NAMES.some((n) => /delete|remove|destroy/.test(n))).toBe(false);
  });

  it('swaps the note tools in after sign-in and announces it', async () => {
    const { client, browser } = await connect(null, { signedIn: false });
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    const pending = client.callTool({ name: 'sign_in', arguments: {} });
    await submitPage(await browser.next(), { baseUrl: srv.baseUrl, username: 'jude', password: PW });
    expect(JSON.parse(text(await pending))).toMatchObject({ outcome: 'signed_in', user: 'jude' });
    await vi.waitFor(() => expect(changed).toBeGreaterThan(0));
    const now = await names(client);
    expect(now).toContain('list_vaults');
    expect(now).not.toContain('sign_in');
    const lines = auditLines();
    expect(lines.filter((l) => l.tool === 'signed_in' && l.ok === true)).toHaveLength(1);
    expect(lines.filter((l) => l.tool === 'sign_in' && l.ok === true)).toHaveLength(1);
  });

  it('a sign-in finished after the client gave up still takes effect', async () => {
    const { client, runtime, browser } = await connect(null, { signedIn: false });
    const ac = new AbortController();
    const pending = client.callTool({ name: 'sign_in', arguments: {} }, undefined, { signal: ac.signal });
    const url = await browser.next();
    ac.abort();
    await expect(pending).rejects.toThrow();
    await submitPage(url, { baseUrl: srv.baseUrl, username: 'jude', password: PW });
    expect(runtime.state.kind).toBe('ready');
    await vi.waitFor(async () => expect(await names(client)).toContain('list_vaults'));
  });

  it('a credential that goes stale mid-session swaps back to sign_in', async () => {
    const { client, runtime } = await connect(cfg(['@read']));
    const s = runtime.session();
    s.call = (async () => {
      throw new CredentialStale();
    }) as Session['call'];
    const res = await client.callTool({ name: 'list_vaults', arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Call sign_in.');
    expect(await names(client)).toEqual(['inked_status', 'sign_in']);
  });

  it('instructions fit the state at start', async () => {
    const out = (await connect(null, { signedIn: false })).client.getInstructions() ?? '';
    expect(out).toContain('call sign_in');
    expect(out).not.toMatch(/list_vaults/);
    const ro = (await connect(cfg(['@read']))).client.getInstructions() ?? '';
    expect(ro).toContain('list_vaults');
    expect(ro).not.toMatch(/append_to_note|update_note|create_notes|sign_in/);
    expect(buildInstructions(TOOL_NAMES)).toMatch(/append_to_note/);
  });

  it('never names a tool that is not listed, in instructions or descriptions', async () => {
    const setups: [unknown | null, boolean][] = [
      [cfg(['@write']), true], [cfg(['note.create']), true], [cfg(['@organize']), true], [cfg(['@read']), true],
      [cfg(['note.update']), true], [cfg(['@manage']), true], [null, true], [null, false],
    ];
    for (const [config, signedIn] of setups) {
      const { client } = await connect(config, { signedIn });
      const tools = (await client.listTools()).tools;
      const listed = tools.map((t) => t.name);
      const all = [client.getInstructions() ?? '', ...tools.map((t) => t.description ?? '')].join('\n');
      for (const n of TOOL_NAMES) {
        if (new RegExp(`\\b${n}\\b`).test(all)) expect(listed, `${JSON.stringify(config)} names ${n}`).toContain(n);
      }
    }
  });

  it('round-trips a write and returns errors as isError results', async () => {
    const { client } = await connect(cfg(['@read', '@write']));
    const made = await client.callTool({ name: 'create_folder', arguments: { vault: 'Work', parent: null, name: 'Topic' } });
    expect(made.isError).toBeFalsy();
    const bad = await client.callTool({ name: 'create_folder', arguments: { vault: 'Work', parent: null, name: 'a/b' } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toBe('Folder names must not contain "/".');
    const tree = await client.callTool({ name: 'get_tree', arguments: { vault: 'Work' } });
    expect(JSON.parse(text(tree)).folders.some((f: { name: string }) => f.name === 'Topic')).toBe(true);
  });

  it('create_vault goes through the page and is audited, including a cancel', async () => {
    const { client, browser } = await connect(cfg(['@read', '@manage']));
    let pending = client.callTool({ name: 'create_vault', arguments: { name: 'Nope' } });
    await submitPage(await browser.next(), {}, 'cancel');
    expect(JSON.parse(text(await pending))).toEqual({ outcome: 'cancelled' });
    expect(auditLines().at(-1)).toMatchObject({ tool: 'create_vault', ok: false, error: 'cancelled' });

    pending = client.callTool({ name: 'create_vault', arguments: { name: 'Scratch' } });
    await submitPage(await browser.next(), { name: 'Scratch', color: '#45A89E' });
    const r = JSON.parse(text(await pending));
    expect(r).toMatchObject({ outcome: 'vault_created', vault: { name: 'Scratch' } });
    const lines = auditLines();
    expect(lines).toContainEqual(expect.objectContaining({ tool: 'vault_created', ok: true, vaultId: r.vault.id }));
    expect(lines.at(-1)).toMatchObject({ tool: 'create_vault', ok: true, vaultId: r.vault.id });
  });

  describe('create_notes with a failed write', () => {
    async function run(failOn: number) {
      const { client, runtime } = await connect(cfg(['@read', '@write']));
      await client.callTool({ name: 'create_folder', arguments: { vault: 'Work', parent: null, name: `Batch${failOn}` } });
      const api = runtime.session().api;
      const orig = api.createNote;
      let calls = 0;
      api.createNote = async (...args: Parameters<typeof orig>) => {
        calls++;
        if (calls === failOn) throw new ApiError(400, 'invalid');
        return orig(...args);
      };
      try {
        const notes = ['a', 'b', 'c'].map((title) => ({ folder: `Batch${failOn}`, title, body: '' }));
        const res = await client.callTool({ name: 'create_notes', arguments: { vault: 'Work', notes } });
        return { res, result: JSON.parse(text(res)), entry: auditLines().at(-1) };
      } finally {
        api.createNote = orig;
      }
    }

    it('some created: result stays {created, failed}, not isError, audited as a partial failure', async () => {
      const { res, result, entry } = await run(2);
      expect(res.isError).toBeFalsy();
      expect(result.created).toHaveLength(1);
      expect(result.failed.index).toBe(1);
      expect(entry).toMatchObject({ tool: 'create_notes', ok: false, error: 'batch_partial', ids: [result.created[0].id] });
    });

    it('none created: isError with the JSON result, audited as batch_failed', async () => {
      const { res, result, entry } = await run(1);
      expect(res.isError).toBe(true);
      expect(result.created).toHaveLength(0);
      expect(result.failed.index).toBe(0);
      expect(entry).toMatchObject({ tool: 'create_notes', ok: false, error: 'batch_failed' });
    });
  });
});
